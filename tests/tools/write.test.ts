import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleToolCall, type ToolContextInput } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import { checkSendLimit, clearSendLimit } from "../../src/tools/write.js";
import { recordSend } from "../../src/sendlog.js";
import type { AccountConfig } from "../../src/accounts.js";

const ORIGINAL = {
  id: "msg-1", from: "Sender <sender@example.net>", replyTo: undefined as string | undefined,
  to: ["me@example.com", "peer@example.org"], cc: ["cc@example.org"], bcc: [],
  subject: "Hello", snippet: "", date: "d", labels: [], hasAttachments: false, body: "original body", attachments: [],
};

function createMockProvider(): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
    sendMessage: vi.fn().mockResolvedValue("sent-msg-1"),
    replyToMessage: vi.fn().mockResolvedValue("reply-msg-1"),
    forwardMessage: vi.fn().mockResolvedValue("fwd-msg-1"),
    createDraft: vi.fn().mockResolvedValue("draft-1"),
    readMessage: vi.fn().mockResolvedValue({ ...ORIGINAL }),
    hasCorrespondedWith: vi.fn().mockResolvedValue(true),
  } as unknown as MailProvider;
}

describe("write tools", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContextInput;
  let logDir: string;
  let config: AccountConfig;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "mbx-write-"));
    process.env.MAILBOX_MCP_LOG_DIR = logDir;
    clearSendLimit("personal");
    config = { provider: "gmail", email: "me@example.com" };
    mockProvider = createMockProvider();
    ctx = {
      accountManager: { listAccounts: vi.fn(), getAccount: vi.fn().mockImplementation(() => config) } as any,
      getProvider: vi.fn().mockReturnValue(mockProvider),
    };
  });

  afterEach(() => {
    delete process.env.MAILBOX_MCP_LOG_DIR;
    rmSync(logDir, { recursive: true, force: true });
  });

  const sent = (p: MailProvider) => vi.mocked(p.sendMessage).mock.calls.length + vi.mocked(p.replyToMessage).mock.calls.length + vi.mocked(p.forwardMessage).mock.calls.length;

  it("send_email sends and returns message ID", async () => {
    const result = await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], subject: "Hi", body: "Hello" }, ctx);
    expect(result.content[0].text).toContain("sent-msg-1");
    expect(mockProvider.sendMessage).toHaveBeenCalledWith(["test@example.net"], "Hi", "Hello", expect.anything());
  });

  it("send_email records the send in the persisted log", async () => {
    await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], cc: ["Cee <cc@example.net>"], subject: "Hi", body: "Hello" }, ctx);
    const lines = readFileSync(join(logDir, "sends.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.account).toBe("personal");
    expect(rec.tool).toBe("send_email");
    expect(rec.to).toEqual(["test@example.net", "cc@example.net"]);
  });

  it("reply_email replies and returns message ID", async () => {
    const result = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "Thanks" }, ctx);
    expect(result.content[0].text).toContain("reply-msg-1");
  });

  it("forward_email forwards within the account's domain and returns message ID", async () => {
    const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["other@example.com"] }, ctx);
    expect(result.content[0].text).toContain("fwd-msg-1");
  });

  it("create_draft creates and returns draft ID", async () => {
    const result = await handleToolCall("create_draft", { account: "personal", to: ["test@example.net"], subject: "Draft", body: "WIP" }, ctx);
    expect(result.content[0].text).toContain("draft-1");
  });

  describe("fences never leak into outgoing mail", () => {
    it("strips nonce and legacy markers from subject and body on every send path", async () => {
      const subject = "[UNTRUSTED_SUBJECT_0123abcd]\nRe: invoice\n[/UNTRUSTED_SUBJECT_0123abcd]";
      const body = "They wrote:\n[UNTRUSTED_EMAIL_CONTENT_0123abcd]\nhello ⟦/UNTRUSTED_EMAIL_CONTENT] there\n[/UNTRUSTED_EMAIL_CONTENT_0123abcd]\n[UNTRUSTED_FROM]\nx\n[/UNTRUSTED_FROM]";
      await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], subject, body }, ctx);
      const [, sentSubject, sentBody] = vi.mocked(mockProvider.sendMessage).mock.calls[0];
      expect(sentSubject).toBe("Re: invoice");
      expect(sentBody).toBe("They wrote:\nhello [/UNTRUSTED_EMAIL_CONTENT] there\nx");
      expect(sentBody).not.toMatch(/UNTRUSTED_[A-Z_]+_[0-9a-f]{8}/);

      await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body }, ctx);
      expect(vi.mocked(mockProvider.replyToMessage).mock.calls[0][1]).not.toMatch(/UNTRUSTED_[A-Z_]+_[0-9a-f]{8}/);

      await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["other@example.com"], message: body }, ctx);
      expect(vi.mocked(mockProvider.forwardMessage).mock.calls[0][2].message).not.toMatch(/UNTRUSTED_[A-Z_]+_[0-9a-f]{8}/);

      await handleToolCall("create_draft", { account: "personal", to: ["test@example.net"], subject, body }, ctx);
      const draftCall = vi.mocked(mockProvider.createDraft).mock.calls[0];
      expect(draftCall[1]).toBe("Re: invoice");
      expect(draftCall[2]).not.toMatch(/UNTRUSTED_[A-Z_]+_[0-9a-f]{8}/);
    });
  });

  describe("new-recipient confirmation", () => {
    beforeEach(() => {
      vi.mocked(mockProvider.hasCorrespondedWith!).mockResolvedValue(false);
    });

    it("refuses send_email to a never-seen address and lists it", async () => {
      const result = await handleToolCall("send_email", { account: "personal", to: ["Stranger <new@example.net>"], subject: "Hi", body: "Hello" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("new@example.net");
      expect(result.content[0].text).toContain("confirm_new_recipient");
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
      expect(existsSync(join(logDir, "sends.jsonl"))).toBe(false);
    });

    it("sends with confirm_new_recipient and remembers the address afterwards", async () => {
      const ok = await handleToolCall("send_email", { account: "personal", to: ["new@example.net"], subject: "Hi", body: "Hello", confirm_new_recipient: true }, ctx);
      expect(ok.isError).toBeUndefined();
      const again = await handleToolCall("send_email", { account: "personal", to: ["new@example.net"], subject: "Hi", body: "Hello" }, ctx);
      expect(again.isError).toBeUndefined();
      expect(sent(mockProvider)).toBe(2);
    });

    it("does not require confirmation for addresses the account has corresponded with", async () => {
      vi.mocked(mockProvider.hasCorrespondedWith!).mockImplementation(async (a: string) => a === "friend@example.net");
      const result = await handleToolCall("send_email", { account: "personal", to: ["friend@example.net"], subject: "Hi", body: "Hello" }, ctx);
      expect(result.isError).toBeUndefined();
    });

    it("reply_email trusts the original sender but checks extra cc/bcc", async () => {
      const plain = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "Thanks", reply_all: true }, ctx);
      expect(plain.isError).toBeUndefined();
      const leak = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "Thanks", bcc: ["attacker@example.net"] }, ctx);
      expect(leak.isError).toBe(true);
      expect(leak.content[0].text).toContain("attacker@example.net");
      expect(vi.mocked(mockProvider.replyToMessage).mock.calls).toHaveLength(1);
    });

    it("forward_email checks its recipients", async () => {
      const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["new@example.com"] }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("new@example.com");
      expect(mockProvider.forwardMessage).not.toHaveBeenCalled();
    });

    it("create_draft does not require confirmation", async () => {
      const result = await handleToolCall("create_draft", { account: "personal", to: ["new@example.net"], subject: "s", body: "b" }, ctx);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("external forward confirmation", () => {
    it("refuses forwarding outside the account's domain without confirm_external_forward", async () => {
      const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["out@attacker.example"] }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("confirm_external_forward");
      expect(result.content[0].text).toContain("out@attacker.example");
      expect(mockProvider.forwardMessage).not.toHaveBeenCalled();
    });

    it("forwards with confirm_external_forward", async () => {
      const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["out@attacker.example"], confirm_external_forward: true }, ctx);
      expect(result.isError).toBeUndefined();
      expect(mockProvider.forwardMessage).toHaveBeenCalled();
    });

    it("needs both flags when the external address is also new", async () => {
      vi.mocked(mockProvider.hasCorrespondedWith!).mockResolvedValue(false);
      const one = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["out@attacker.example"], confirm_external_forward: true }, ctx);
      expect(one.isError).toBe(true);
      expect(one.content[0].text).toContain("confirm_new_recipient");
      const both = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["out@attacker.example"], confirm_external_forward: true, confirm_new_recipient: true }, ctx);
      expect(both.isError).toBeUndefined();
    });
  });

  describe("recipient allowlist", () => {
    beforeEach(() => {
      config = { provider: "gmail", email: "me@example.com", allowedRecipients: ["boss@example.com", "@example.org"] };
    });

    it("refuses sends, replies, forwards and drafts to addresses off the list", async () => {
      for (const [tool, args] of [
        ["send_email", { account: "personal", to: ["boss@example.com", "leak@attacker.example"], subject: "s", body: "b", confirm_new_recipient: true }],
        ["create_draft", { account: "personal", to: ["leak@attacker.example"], subject: "s", body: "b" }],
        ["forward_email", { account: "personal", message_id: "msg-1", to: ["leak@attacker.example"], confirm_new_recipient: true, confirm_external_forward: true }],
        ["reply_email", { account: "personal", message_id: "msg-1", body: "b" }],
      ] as const) {
        const result = await handleToolCall(tool, args as any, ctx);
        expect(result.isError, tool).toBe(true);
        expect(result.content[0].text, tool).toMatch(/allowlist/);
      }
      expect(sent(mockProvider)).toBe(0);
      expect(mockProvider.createDraft).not.toHaveBeenCalled();
    });

    it("allows listed recipients", async () => {
      const result = await handleToolCall("send_email", { account: "personal", to: ["boss@example.com"], cc: ["anyone@example.org"], subject: "s", body: "b" }, ctx);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("draftsOnly accounts", () => {
    beforeEach(() => {
      config = { provider: "gmail", email: "me@example.com", draftsOnly: true };
      vi.mocked(mockProvider.hasCorrespondedWith!).mockResolvedValue(false);
    });

    it("send_email creates a draft and says so", async () => {
      const result = await handleToolCall("send_email", { account: "personal", to: ["new@example.net"], subject: "s", body: "b" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toMatch(/draftsOnly/);
      expect(result.content[0].text).toContain("draft-1");
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
      expect(mockProvider.createDraft).toHaveBeenCalledWith(["new@example.net"], "s", "b", expect.anything());
      expect(existsSync(join(logDir, "sends.jsonl"))).toBe(false);
    });

    it("reply_email creates a reply draft to the original sender", async () => {
      const result = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "b" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(mockProvider.replyToMessage).not.toHaveBeenCalled();
      const call = vi.mocked(mockProvider.createDraft).mock.calls[0];
      expect(call[0]).toEqual(["Sender <sender@example.net>"]);
      expect(call[3]?.inReplyTo).toBe("msg-1");
    });

    it("forward_email creates a forward draft with the original body", async () => {
      const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["out@attacker.example"], message: "FYI" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(mockProvider.forwardMessage).not.toHaveBeenCalled();
      const call = vi.mocked(mockProvider.createDraft).mock.calls[0];
      expect(call[1]).toBe("Fwd: Hello");
      expect(call[2]).toContain("FYI");
      expect(call[2]).toContain("original body");
    });

    it("still enforces the allowlist", async () => {
      config = { provider: "gmail", email: "me@example.com", draftsOnly: true, allowedRecipients: ["@example.com"] };
      const result = await handleToolCall("send_email", { account: "personal", to: ["new@example.net"], subject: "s", body: "b" }, ctx);
      expect(result.isError).toBe(true);
      expect(mockProvider.createDraft).not.toHaveBeenCalled();
    });
  });

  describe("read-only accounts", () => {
    it("refuses sends and drafts", async () => {
      config = { provider: "gmail", email: "me@example.com", readOnly: true };
      const send = await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], subject: "s", body: "b", confirm_new_recipient: true }, ctx);
      expect(send.isError).toBe(true);
      expect(send.content[0].text).toMatch(/read-only/);
      const draft = await handleToolCall("create_draft", { account: "personal", to: ["test@example.net"], subject: "s", body: "b" }, ctx);
      expect(draft.isError).toBe(true);
      expect(sent(mockProvider)).toBe(0);
      expect(mockProvider.createDraft).not.toHaveBeenCalled();
    });
  });

  describe("daily send cap", () => {
    it("refuses once the persisted count reaches the account's limit", async () => {
      config = { provider: "gmail", email: "me@example.com", dailySendLimit: 2 };
      for (let i = 0; i < 2; i++) recordSend("personal", "send_email", ["test@example.net"]);
      const result = await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], subject: "s", body: "b" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Daily send limit reached: 2 messages/);
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
    });

    it("defaults to 100 and ignores other accounts and old sends", async () => {
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const lines = [];
      for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ ts: old, account: "personal", tool: "send_email", to: ["a@example.net"] }));
      for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ ts: new Date().toISOString(), account: "other", tool: "send_email", to: ["a@example.net"] }));
      for (let i = 0; i < 99; i++) lines.push(JSON.stringify({ ts: new Date().toISOString(), account: "personal", tool: "send_email", to: ["a@example.net"] }));
      writeFileSync(join(logDir, "sends.jsonl"), lines.join("\n") + "\n");
      const ok = await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], subject: "s", body: "b" }, ctx);
      expect(ok.isError).toBeUndefined();
      const capped = await handleToolCall("send_email", { account: "personal", to: ["test@example.net"], subject: "s", body: "b" }, ctx);
      expect(capped.isError).toBe(true);
      expect(capped.content[0].text).toMatch(/limit 100/);
    });
  });

  describe("attachments pass-through", () => {
    let fixtureDir: string;
    let pdfPath: string;

    beforeAll(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), "mbx-write-att-"));
      pdfPath = join(fixtureDir, "report.pdf");
      writeFileSync(pdfPath, Buffer.from("%PDF-1.4\nhello"));
    });

    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("send_email loads paths and passes Attachment[] to the provider", async () => {
      await handleToolCall(
        "send_email",
        { account: "personal", to: ["a@example.net"], subject: "s", body: "b", attachments: [pdfPath] },
        ctx,
      );
      const call = (mockProvider.sendMessage as any).mock.calls[0];
      const options = call[3];
      expect(options.attachments).toHaveLength(1);
      expect(options.attachments[0].filename).toBe("report.pdf");
      expect(options.attachments[0].mimeType).toBe("application/pdf");
      expect(Buffer.isBuffer(options.attachments[0].data)).toBe(true);
    });

    it("reply_email forwards attachments to the provider", async () => {
      await handleToolCall(
        "reply_email",
        { account: "personal", message_id: "m1", body: "hi", attachments: [pdfPath] },
        ctx,
      );
      const call = (mockProvider.replyToMessage as any).mock.calls[0];
      expect(call[2].attachments).toHaveLength(1);
    });

    it("forward_email forwards attachments to the provider", async () => {
      await handleToolCall(
        "forward_email",
        { account: "personal", message_id: "m1", to: ["c@example.com"], attachments: [pdfPath] },
        ctx,
      );
      const call = (mockProvider.forwardMessage as any).mock.calls[0];
      expect(call[2].attachments).toHaveLength(1);
    });

    it("create_draft forwards attachments to the provider", async () => {
      await handleToolCall(
        "create_draft",
        { account: "personal", to: ["a@example.net"], subject: "s", body: "b", attachments: [pdfPath] },
        ctx,
      );
      const call = (mockProvider.createDraft as any).mock.calls[0];
      expect(call[3].attachments).toHaveLength(1);
    });

    it("surfaces a clear error when the attachment path is missing", async () => {
      const result = await handleToolCall(
        "send_email",
        { account: "personal", to: ["a@example.net"], subject: "s", body: "b", attachments: ["/no/such/file.pdf"] },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Attachment not found/);
    });
  });

  describe("rate limiter", () => {
    it("clearSendLimit resets the counter for an alias", () => {
      const alias = "clear-test";
      for (let i = 0; i < 10; i++) expect(checkSendLimit(alias)).toBeNull();
      expect(checkSendLimit(alias)).toMatch(/Rate limit/);
      clearSendLimit(alias);
      expect(checkSendLimit(alias)).toBeNull();
    });
  });
});
