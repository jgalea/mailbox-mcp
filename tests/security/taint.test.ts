import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleToolCall, type ToolContextInput } from "../../src/tools/registry.js";
import { clearTaint, dmarcPasses, isTainted, isTrustedSender, senderAddress } from "../../src/security/taint.js";
import { listPending } from "../../src/pending.js";
import { hasSentTo as sendlogHasSentTo, recordSend } from "../../src/sendlog.js";
import { clearSendLimit } from "../../src/tools/write.js";
import type { MailProvider, SenderAuth } from "../../src/providers/interface.js";
import type { AccountConfig } from "../../src/accounts.js";
import "../../src/tools/read.js";
import "../../src/tools/write.js";
import "../../src/tools/actions.js";
import "../../src/tools/export.js";
import "../../src/tools/attachments.js";
import "../../src/tools/gmail-only.js";

const STRANGER = "Stranger <stranger@example.net>";
const FRIEND = "Friend <friend@example.net>";

function domainOf(from: string): string {
  return senderAddress(from)!.split("@")[1];
}
function pass(domain: string, authserv = "mx.google.com"): string {
  return `${authserv};\n       dkim=pass header.i=@${domain} header.s=sel header.b=abc;\n       spf=pass (google.com: domain of x designates 1.2.3.4 as permitted sender) smtp.mailfrom=${domain};\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`;
}
function authFor(from: string, overrides: Partial<SenderAuth> = {}): SenderAuth {
  return { authenticationResults: [pass(domainOf(from))], sent: false, ...overrides };
}

type Msg = { from: string; auth?: SenderAuth };

function summary(m: Msg) {
  return { id: "m-1", from: m.from, to: ["me@example.com"], subject: "Hi", snippet: "snippet", date: "2026-10-01", labels: [], hasAttachments: false, ...(m.auth ? { auth: m.auth } : {}) };
}
function message(m: Msg) {
  return { ...summary(m), body: "body text", cc: [], bcc: [], attachments: [] };
}

function createMockProvider(m: Msg = { from: STRANGER, auth: authFor(STRANGER) }): MailProvider {
  const authHeaders = (m.auth?.authenticationResults ?? []).map((value) => ({ name: "Authentication-Results", value }));
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
    gmailApi: { users: { messages: { get: vi.fn().mockResolvedValue({ data: { labelIds: m.auth?.sent ? ["SENT"] : ["INBOX"], payload: { headers: [{ name: "List-Unsubscribe", value: "<https://example.net/u>" }, { name: "From", value: m.from }, ...authHeaders] } } }) } } },
    searchMessages: vi.fn().mockResolvedValue([summary(m)]),
    readMessage: vi.fn().mockResolvedValue(message(m)),
    readThread: vi.fn().mockResolvedValue({ id: "t1", subject: "Hi", messages: [message(m)] }),
    inboxSummary: vi.fn().mockResolvedValue({ total: 1, unread: 1, recent: [summary(m)] }),
    messagesSince: vi.fn().mockResolvedValue([summary(m)]),
    exportMessage: vi.fn().mockResolvedValue({ filename: "m.eml", data: Buffer.from("raw"), mimeType: "message/rfc822" }),
    downloadAttachment: vi.fn().mockResolvedValue({ filename: "a.pdf", data: Buffer.from("x"), mimeType: "application/pdf" }),
    sendMessage: vi.fn().mockResolvedValue("sent-1"),
    replyToMessage: vi.fn().mockResolvedValue("reply-1"),
    createDraft: vi.fn().mockResolvedValue("draft-1"),
    hasCorrespondedWith: vi.fn().mockResolvedValue(true),
    hasSentTo: vi.fn().mockResolvedValue(false),
  } as unknown as MailProvider;
}

describe("untrustedReadLock", () => {
  let dir: string;
  let saveDir: string;
  let provider: MailProvider;
  let ctx: ToolContextInput;
  let configs: Record<string, AccountConfig>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mbx-taint-"));
    saveDir = mkdtempSync("/tmp/mbx-taint-save-");
    process.env.MAILBOX_MCP_LOG_DIR = dir;
    process.env.MAILBOX_MCP_CONFIG_DIR = dir;
    clearTaint();
    clearSendLimit("personal");
    configs = { personal: { provider: "gmail", email: "me@example.com", untrustedReadLock: "approval" } };
    provider = createMockProvider();
    ctx = {
      accountManager: {
        listAccounts: vi.fn().mockImplementation(() => configs),
        getAccount: vi.fn().mockImplementation((alias: string) => {
          if (!configs[alias]) throw new Error(`Account "${alias}" not found`);
          return configs[alias];
        }),
      } as any,
      getProvider: vi.fn().mockReturnValue(provider),
    };
  });

  afterEach(() => {
    delete process.env.MAILBOX_MCP_LOG_DIR;
    delete process.env.MAILBOX_MCP_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(saveDir, { recursive: true, force: true });
  });

  const read = () => handleToolCall("read_email", { account: "personal", message_id: "m1" }, ctx);
  const send = (extra: Record<string, unknown> = {}) =>
    handleToolCall("send_email", { account: "personal", to: ["friend@example.net"], subject: "s", body: "b", ...extra }, ctx);
  const useMessage = (m: Msg) => {
    provider = createMockProvider(m);
    ctx.getProvider = vi.fn().mockReturnValue(provider);
  };
  const knowFriend = () => recordSend("personal", "send_email", ["friend@example.net"]);

  describe("what sets the taint", () => {
    it("authenticated mail from a sender the account never wrote to", async () => {
      await read();
      expect(isTainted("personal")).toMatchObject({ sender: "stranger@example.net", tool: "read_email" });
      expect(provider.hasSentTo).toHaveBeenCalledWith("stranger@example.net");
    });

    it("not authenticated mail from a sender in the local send log, and the provider is not asked", async () => {
      knowFriend();
      useMessage({ from: FRIEND, auth: authFor(FRIEND) });
      await read();
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).not.toHaveBeenCalled();
    });

    it("not authenticated mail from a sender the provider's Sent folder knows, and the answer is cached per process", async () => {
      useMessage({ from: FRIEND, auth: authFor(FRIEND) });
      vi.mocked(provider.hasSentTo!).mockResolvedValue(true);
      await read();
      await read();
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).toHaveBeenCalledTimes(1);
    });

    it("a known sender without authentication is untrusted: a From header on its own proves nothing", async () => {
      knowFriend();
      for (const auth of [undefined, { authenticationResults: [], sent: false }]) {
        clearTaint();
        useMessage({ from: FRIEND, auth });
        await read();
        expect(isTainted("personal"), JSON.stringify(auth)).toMatchObject({ sender: "friend@example.net" });
        expect(provider.hasSentTo).not.toHaveBeenCalled();
      }
    });

    it("a known sender whose DMARC evidence is wrong in any way is untrusted", async () => {
      knowFriend();
      const cases: Record<string, string[]> = {
        "dmarc=fail": [pass("example.net").replace("dmarc=pass", "dmarc=fail")],
        "dmarc=none": [pass("example.net").replace("dmarc=pass", "dmarc=none")],
        "header.from names another domain": [pass("attacker.example")],
        "header.from is a lookalike": [pass("example.net.attacker.example")],
        "topmost result is not from the account's own server": [pass("example.net", "mx.attacker.example")],
        "the passing result is only in a lower header": [`mx.google.com; dmarc=fail header.from=example.net`, pass("example.net")],
        "two dmarc results": [`mx.google.com; dmarc=pass header.from=example.net; dmarc=fail header.from=example.net`],
        "no dmarc result at all": [`mx.google.com; spf=pass smtp.mailfrom=example.net`],
        "no header.from": [`mx.google.com; dmarc=pass (p=NONE)`],
      };
      for (const [name, results] of Object.entries(cases)) {
        clearTaint();
        useMessage({ from: FRIEND, auth: { authenticationResults: results, sent: false } });
        await read();
        expect(isTainted("personal"), name).toBeDefined();
        expect(provider.hasSentTo, name).not.toHaveBeenCalled();
      }
    });

    it("the account's own address is trusted only for mail that is actually in Sent", async () => {
      useMessage({ from: "Me <me@example.com>", auth: { authenticationResults: [pass("example.com")], sent: false } });
      await read();
      expect(isTainted("personal")).toMatchObject({ sender: "me@example.com" });
      clearTaint();
      useMessage({ from: "Me <me@example.com>", auth: { authenticationResults: [], sent: true } });
      await read();
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).not.toHaveBeenCalled();
    });

    it("mail the account itself sent is trusted whoever it is addressed from", async () => {
      useMessage({ from: "Alias <alias@example.org>", auth: { authenticationResults: [], sent: true } });
      await read();
      expect(isTainted("personal")).toBeUndefined();
    });

    it("on IMAP and JMAP nothing is authenticated until authservId is configured", async () => {
      knowFriend();
      configs.personal = { provider: "imap", email: "me@example.com", host: "h", port: 993, smtpHost: "s", smtpPort: 587, untrustedReadLock: "approval" };
      useMessage({ from: FRIEND, auth: { authenticationResults: [pass("example.net", "mx1.messagingengine.com")], sent: false } });
      await read();
      expect(isTainted("personal")).toBeDefined();
      clearTaint();
      configs.personal = { ...configs.personal, authservId: "mx1.messagingengine.com" };
      await read();
      expect(isTainted("personal")).toBeUndefined();
    });

    it("received mail from the sender does not make them trusted", async () => {
      vi.mocked(provider.hasCorrespondedWith!).mockResolvedValue(true);
      vi.mocked(provider.hasSentTo!).mockResolvedValue(false);
      await read();
      expect(isTainted("personal")).toBeDefined();
    });

    it("a failed Sent-folder lookup counts as untrusted", async () => {
      vi.mocked(provider.hasSentTo!).mockRejectedValue(new Error("quota"));
      await read();
      expect(isTainted("personal")).toBeDefined();
    });

    it("a provider that cannot check Sent falls back to the local log only", async () => {
      useMessage({ from: FRIEND, auth: authFor(FRIEND) });
      delete (provider as any).hasSentTo;
      await read();
      expect(isTainted("personal")).toBeDefined();
      clearTaint();
      knowFriend();
      await read();
      expect(isTainted("personal")).toBeUndefined();
    });

    it("a From header a parser could read two ways is untrusted even when it names a known address", async () => {
      knowFriend();
      for (const from of [
        "friend@example.net, attacker@example.org",
        "\"<friend@example.net>\" <attacker@example.org>",
        "friend@example.net <attacker@example.org>",
        "\"friend@example.net\" <attacker@example.org>",
        "fri​end@example.net",
        "friend@example.net‮",
        "",
        "   ",
        "undisclosed",
      ]) {
        clearTaint();
        useMessage({ from, auth: { authenticationResults: [pass("example.net")], sent: false } });
        await read();
        expect(isTainted("personal"), JSON.stringify(from)).toBeDefined();
        expect(provider.hasSentTo, JSON.stringify(from)).not.toHaveBeenCalled();
      }
    });

    it("plain forms of a known, authenticated address are trusted", async () => {
      knowFriend();
      for (const from of ["friend@example.net", "Friend <friend@example.net>", "\"Friend, Jr.\" <FRIEND@Example.net>", " <friend@example.net> "]) {
        clearTaint();
        useMessage({ from, auth: { authenticationResults: [pass("example.net")], sent: false } });
        await read();
        expect(isTainted("personal"), from).toBeUndefined();
      }
    });

    it("every tool that renders or exports content sets it", async () => {
      for (const [tool, args] of [
        ["search_emails", { account: "personal", query: "x" }],
        ["read_thread", { account: "personal", thread_id: "t1" }],
        ["inbox_summary", { account: "personal" }],
        ["emails_since", { account: "personal", since: "2026-01-01T00:00:00Z" }],
        ["unsubscribe", { account: "personal", message_id: "m1" }],
        ["bulk_unsubscribe", { account: "personal", message_ids: ["m1"] }],
        ["export_email", { account: "personal", message_id: "m1", save_to: saveDir }],
        ["export_thread", { account: "personal", thread_id: "t1", save_to: saveDir }],
        ["download_attachment", { account: "personal", message_id: "m1", attachment_id: "a1", save_to: saveDir }],
      ] as const) {
        clearTaint();
        const result = await handleToolCall(tool, args as any, ctx);
        expect(result.isError, `${tool}: ${result.content[0].text}`).toBeUndefined();
        expect(isTainted("personal")?.tool, tool).toBe(tool);
      }
    });

    it("every rendering tool passes the provider's evidence through, so a known authenticated sender does not taint", async () => {
      knowFriend();
      useMessage({ from: FRIEND, auth: authFor(FRIEND) });
      for (const [tool, args] of [
        ["search_emails", { account: "personal", query: "x" }],
        ["read_thread", { account: "personal", thread_id: "t1" }],
        ["inbox_summary", { account: "personal" }],
        ["emails_since", { account: "personal", since: "2026-01-01T00:00:00Z" }],
        ["unsubscribe", { account: "personal", message_id: "m1" }],
        ["bulk_unsubscribe", { account: "personal", message_ids: ["m1"] }],
      ] as const) {
        clearTaint();
        await handleToolCall(tool, args as any, ctx);
        expect(isTainted("personal"), tool).toBeUndefined();
      }
    });

    it("exports taint even when the sender would have been trusted, since the content leaves the fence", async () => {
      knowFriend();
      useMessage({ from: FRIEND, auth: authFor(FRIEND) });
      await handleToolCall("export_email", { account: "personal", message_id: "m1", save_to: saveDir }, ctx);
      expect(isTainted("personal")?.tool).toBe("export_email");
    });

    it("an error while deciding counts as untrusted", async () => {
      ctx.getProvider = vi.fn().mockReturnValueOnce(provider).mockImplementation(() => { throw new Error("connection lost"); });
      await read();
      expect(isTainted("personal")).toBeDefined();
    });

    it("multi_account_search taints only the account whose results had the untrusted sender", async () => {
      configs.work = { provider: "gmail", email: "work@example.com", untrustedReadLock: "refuse" };
      const workProvider = createMockProvider({ from: "Work <work@example.com>", auth: { authenticationResults: [], sent: true } });
      ctx.getProvider = vi.fn().mockImplementation((alias: string) => (alias === "work" ? workProvider : provider));
      await handleToolCall("multi_account_search", { query: "x" }, ctx);
      expect(isTainted("personal")?.tool).toBe("multi_account_search");
      expect(isTainted("work")).toBeUndefined();
    });

    it("nothing is evaluated when the option is not set", async () => {
      configs.personal = { provider: "gmail", email: "me@example.com" };
      await read();
      await handleToolCall("export_email", { account: "personal", message_id: "m1", save_to: saveDir }, ctx);
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).not.toHaveBeenCalled();
    });

    it("is per account", async () => {
      configs.work = { provider: "gmail", email: "work@example.com", untrustedReadLock: "refuse" };
      await read();
      const result = await handleToolCall("send_email", { account: "work", to: ["friend@example.net"], subject: "s", body: "b" }, ctx);
      expect(result.content[0].text).toContain("sent-1");
    });
  });

  describe("approval mode", () => {
    it("sends go through normally before any untrusted read", async () => {
      const result = await send();
      expect(result.content[0].text).toContain("sent-1");
      expect(listPending()).toEqual([]);
    });

    it("once tainted, every send is queued even though approval is not set", async () => {
      await read();
      const result = await send();
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/Queued for approval, nothing was sent/);
      expect(result.content[0].text).toContain("stranger@example.net");
      expect(provider.sendMessage).not.toHaveBeenCalled();
      expect(existsSync(join(dir, "sends.jsonl"))).toBe(false);
      const [spec] = listPending();
      expect(spec).toMatchObject({ reason: "untrusted-read", taintedBy: "stranger@example.net via read_email", to: ["friend@example.net"] });

      const reply = await handleToolCall("reply_email", { account: "personal", message_id: "m1", body: "ok" }, ctx);
      expect(reply.content[0].text).toMatch(/Queued for approval/);
      expect(provider.replyToMessage).not.toHaveBeenCalled();
    });

    it("drafts are still created directly", async () => {
      await read();
      const result = await handleToolCall("create_draft", { account: "personal", to: ["friend@example.net"], subject: "s", body: "b" }, ctx);
      expect(result.content[0].text).toContain("draft-1");
      expect(listPending()).toEqual([]);
    });
  });

  describe("refuse mode", () => {
    beforeEach(() => {
      configs.personal = { provider: "gmail", email: "me@example.com", untrustedReadLock: "refuse" };
    });

    it("refuses every send for the rest of the process and says a restart clears it", async () => {
      await read();
      const result = await send();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/read_email showed mail from stranger@example.net/);
      expect(result.content[0].text).toMatch(/restarting the MCP server clears it/);
      expect(provider.sendMessage).not.toHaveBeenCalled();
      expect(listPending()).toEqual([]);
      const reply = await handleToolCall("reply_email", { account: "personal", message_id: "m1", body: "ok" }, ctx);
      expect(reply.isError).toBe(true);
    });

    it("the existing guards still answer first when they fail", async () => {
      configs.personal = { ...configs.personal, allowedRecipients: ["@example.com"] };
      await read();
      const result = await send();
      expect(result.content[0].text).toMatch(/allowlist/);
    });

    it("a restart (cleared taint) lets sends through again", async () => {
      await read();
      expect((await send()).isError).toBe(true);
      clearTaint();
      expect((await send()).content[0].text).toContain("sent-1");
    });
  });

  describe("no argument lifts the lock", () => {
    it("confirm_new_recipient and confirm_external_forward do not bypass refuse", async () => {
      configs.personal = { provider: "gmail", email: "me@example.com", untrustedReadLock: "refuse" };
      await read();
      const result = await send({ confirm_new_recipient: true, confirm_external_forward: true, confirm_untrusted_read: true, approve: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No argument lifts this/);
      expect(provider.sendMessage).not.toHaveBeenCalled();
    });

    it("nor do they bypass approval routing", async () => {
      await read();
      const result = await send({ confirm_new_recipient: true, confirm_external_forward: true, confirm_untrusted_read: true });
      expect(result.content[0].text).toMatch(/Queued for approval/);
      expect(provider.sendMessage).not.toHaveBeenCalled();
    });
  });
});

describe("senderAddress", () => {
  it("accepts one plain address in the usual forms", () => {
    expect(senderAddress("a@example.net")).toBe("a@example.net");
    expect(senderAddress("Name <A@Example.net>")).toBe("a@example.net");
    expect(senderAddress("\"Last, First\" <a@example.net>")).toBe("a@example.net");
    expect(senderAddress("  <a@example.net>  ")).toBe("a@example.net");
  });

  it("returns null for anything ambiguous", () => {
    for (const raw of [
      "", "   ", "nobody", "a@example.net, b@example.org", "<a@example.net> <b@example.org>",
      "\"<a@example.net>\" <b@example.org>", "a@example.net <b@example.org>", "\"a@example.net\" <b@example.org>",
      "a​@example.net", "a@example.net‮", "a@example.net\u0007", "<a@example.net", "a@b", "@example.net", "a@@example.net",
    ]) {
      expect(senderAddress(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("dmarcPasses", () => {
  const good = pass("example.net");

  it("needs the account's authserv-id on top, exactly one dmarc=pass, and header.from equal to the From domain", () => {
    expect(dmarcPasses([good], "a@example.net", "mx.google.com")).toBe(true);
    expect(dmarcPasses([good], "a@EXAMPLE.net", "MX.GOOGLE.COM")).toBe(true);
    expect(dmarcPasses([good], "a@example.net", undefined)).toBe(false);
    expect(dmarcPasses(undefined, "a@example.net", "mx.google.com")).toBe(false);
    expect(dmarcPasses([], "a@example.net", "mx.google.com")).toBe(false);
    expect(dmarcPasses([good], "a@other.example", "mx.google.com")).toBe(false);
    expect(dmarcPasses([good], "a@example.net", "mx.other.example")).toBe(false);
    expect(dmarcPasses([good.replace("dmarc=pass", "dmarc=passing")], "a@example.net", "mx.google.com")).toBe(false);
    expect(dmarcPasses(["mx.google.com; dmarc=pass header.from=example.net; dmarc=pass header.from=example.net"], "a@example.net", "mx.google.com")).toBe(false);
    expect(dmarcPasses(["mx.attacker.example; dmarc=pass header.from=example.net", good], "a@example.net", "mx.google.com")).toBe(false);
  });

  it("does not let an authserv-id smuggled into a comment pass", () => {
    expect(dmarcPasses(["mx.attacker.example (mx.google.com); dmarc=pass header.from=example.net"], "a@example.net", "mx.google.com")).toBe(false);
  });
});

describe("isTrustedSender", () => {
  let dir: string;
  const config: AccountConfig = { provider: "gmail", email: "me@example.com" };
  const authed = (from: string) => ({ from, auth: authFor(from) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mbx-trust-"));
    process.env.MAILBOX_MCP_LOG_DIR = dir;
    clearTaint();
  });
  afterEach(() => {
    delete process.env.MAILBOX_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats an empty or unparsable sender as untrusted without asking the provider", async () => {
    const p = { hasSentTo: vi.fn().mockResolvedValue(true) } as unknown as MailProvider;
    expect(await isTrustedSender("a", config, p, { from: "", auth: { authenticationResults: [pass("example.net")], sent: false } })).toBe(false);
    expect(await isTrustedSender("a", config, p, { from: "x@example.net, me@example.com", auth: { authenticationResults: [pass("example.net")], sent: false } })).toBe(false);
    expect(p.hasSentTo).not.toHaveBeenCalled();
  });

  it("does not let one account's send log vouch for another", async () => {
    recordSend("other", "send_email", ["x@example.net"]);
    const p = { hasSentTo: vi.fn().mockResolvedValue(false) } as unknown as MailProvider;
    expect(await isTrustedSender("a", config, p, authed("x@example.net"))).toBe(false);
    expect(await isTrustedSender("other", config, p, authed("x@example.net"))).toBe(true);
  });

  it("does not cache a failed lookup", async () => {
    const p = { hasSentTo: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(true) } as unknown as MailProvider;
    expect(await isTrustedSender("a", config, p, authed("x@example.net"))).toBe(false);
    expect(await isTrustedSender("a", config, p, authed("x@example.net"))).toBe(true);
  });

  it("the local send log matches whole addresses only", () => {
    recordSend("a", "send_email", ["xa@example.com", "Friend <friend@example.net>"]);
    expect(sendlogHasSentTo("a", "a@example.co")).toBe(false);
    expect(sendlogHasSentTo("a", "a@example.com")).toBe(false);
    expect(sendlogHasSentTo("a", "xa@example.com")).toBe(true);
    expect(sendlogHasSentTo("a", "FRIEND@example.net")).toBe(true);
  });
});
