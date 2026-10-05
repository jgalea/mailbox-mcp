import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleToolCall, type ToolContextInput } from "../../src/tools/registry.js";
import { clearTaint, isTainted, isTrustedSender, senderAddress } from "../../src/security/taint.js";
import { listPending } from "../../src/pending.js";
import { recordSend } from "../../src/sendlog.js";
import { clearSendLimit } from "../../src/tools/write.js";
import type { MailProvider } from "../../src/providers/interface.js";
import type { AccountConfig } from "../../src/accounts.js";
import "../../src/tools/read.js";
import "../../src/tools/write.js";
import "../../src/tools/actions.js";
import "../../src/tools/export.js";
import "../../src/tools/attachments.js";
import "../../src/tools/gmail-only.js";

function summary(from: string) {
  return { id: "m-" + from, from, to: ["me@example.com"], subject: "Hi", snippet: "snippet", date: "2026-10-01", labels: [], hasAttachments: false };
}
function message(from: string) {
  return { ...summary(from), body: "body text", cc: [], bcc: [], attachments: [] };
}

function createMockProvider(from = "Stranger <stranger@example.net>"): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
    gmailApi: { users: { messages: { get: vi.fn().mockResolvedValue({ data: { payload: { headers: [{ name: "List-Unsubscribe", value: "<https://example.net/u>" }, { name: "From", value: from }] } } }) } } },
    searchMessages: vi.fn().mockResolvedValue([summary(from)]),
    readMessage: vi.fn().mockResolvedValue(message(from)),
    readThread: vi.fn().mockResolvedValue({ id: "t1", subject: "Hi", messages: [message(from)] }),
    inboxSummary: vi.fn().mockResolvedValue({ total: 1, unread: 1, recent: [summary(from)] }),
    messagesSince: vi.fn().mockResolvedValue([summary(from)]),
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
  const useSender = (from: string) => {
    provider = createMockProvider(from);
    ctx.getProvider = vi.fn().mockReturnValue(provider);
  };

  describe("what sets the taint", () => {
    it("mail from a sender the account never wrote to", async () => {
      await read();
      expect(isTainted("personal")).toMatchObject({ sender: "stranger@example.net", tool: "read_email" });
      expect(provider.hasSentTo).toHaveBeenCalledWith("stranger@example.net");
    });

    it("not a sender in the local send log, and the provider is not asked", async () => {
      recordSend("personal", "send_email", ["Stranger <stranger@example.net>"]);
      await read();
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).not.toHaveBeenCalled();
    });

    it("not a sender the provider's Sent folder knows, and the answer is cached per process", async () => {
      vi.mocked(provider.hasSentTo!).mockResolvedValue(true);
      await read();
      await read();
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).toHaveBeenCalledTimes(1);
    });

    it("not the account's own address", async () => {
      useSender("Me <me@example.com>");
      await read();
      expect(isTainted("personal")).toBeUndefined();
      expect(provider.hasSentTo).not.toHaveBeenCalled();
    });

    it("having received mail from the sender does not make them trusted", async () => {
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
      delete (provider as any).hasSentTo;
      await read();
      expect(isTainted("personal")).toBeDefined();
      clearTaint();
      recordSend("personal", "send_email", ["stranger@example.net"]);
      await read();
      expect(isTainted("personal")).toBeUndefined();
    });

    it("a From header a parser could read two ways is untrusted even when it names a known address", async () => {
      recordSend("personal", "send_email", ["friend@example.net"]);
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
        useSender(from);
        await read();
        expect(isTainted("personal"), JSON.stringify(from)).toBeDefined();
        expect(provider.hasSentTo, JSON.stringify(from)).not.toHaveBeenCalled();
      }
    });

    it("plain forms of a known address are trusted", async () => {
      recordSend("personal", "send_email", ["friend@example.net"]);
      for (const from of ["friend@example.net", "Friend <friend@example.net>", "\"Friend, Jr.\" <FRIEND@Example.net>", " <friend@example.net> "]) {
        clearTaint();
        useSender(from);
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

    it("exports taint even when the sender would have been trusted, since the content leaves the fence", async () => {
      recordSend("personal", "send_email", ["stranger@example.net"]);
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
      const workProvider = createMockProvider("Work <work@example.com>");
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

describe("isTrustedSender", () => {
  let dir: string;
  const config: AccountConfig = { provider: "gmail", email: "me@example.com" };

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
    expect(await isTrustedSender("a", config, p, "")).toBe(false);
    expect(await isTrustedSender("a", config, p, "x@example.net, me@example.com")).toBe(false);
    expect(p.hasSentTo).not.toHaveBeenCalled();
  });

  it("does not let one account's send log vouch for another", async () => {
    recordSend("other", "send_email", ["x@example.net"]);
    const p = { hasSentTo: vi.fn().mockResolvedValue(false) } as unknown as MailProvider;
    expect(await isTrustedSender("a", config, p, "x@example.net")).toBe(false);
    expect(await isTrustedSender("other", config, p, "x@example.net")).toBe(true);
  });

  it("does not cache a failed lookup", async () => {
    const p = { hasSentTo: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(true) } as unknown as MailProvider;
    expect(await isTrustedSender("a", config, p, "x@example.net")).toBe(false);
    expect(await isTrustedSender("a", config, p, "x@example.net")).toBe(true);
  });
});
