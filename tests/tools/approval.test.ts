import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleToolCall, type ToolContextInput } from "../../src/tools/registry.js";
import { listPending } from "../../src/pending.js";
import { clearSendLimit } from "../../src/tools/write.js";
import type { MailProvider } from "../../src/providers/interface.js";
import type { AccountConfig } from "../../src/accounts.js";
import "../../src/tools/write.js";
import "../../src/tools/actions.js";
import "../../src/tools/gmail-only.js";

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
    sendDraft: vi.fn().mockResolvedValue("sent-draft-1"),
    createDraft: vi.fn().mockResolvedValue("draft-1"),
    readMessage: vi.fn().mockResolvedValue({ ...ORIGINAL }),
    getDraftRecipients: vi.fn().mockResolvedValue(["To <draft-to@example.com>", "draft-cc@example.org"]),
    draftFingerprint: vi.fn().mockResolvedValue("fp-1"),
    hasCorrespondedWith: vi.fn().mockResolvedValue(true),
  } as unknown as MailProvider;
}

const sent = (p: MailProvider) =>
  vi.mocked(p.sendMessage).mock.calls.length + vi.mocked(p.replyToMessage).mock.calls.length
  + vi.mocked(p.forwardMessage).mock.calls.length + vi.mocked(p.sendDraft).mock.calls.length;

describe("approval: external", () => {
  let provider: MailProvider;
  let ctx: ToolContextInput;
  let dir: string;
  let config: AccountConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mbx-approval-"));
    process.env.MAILBOX_MCP_LOG_DIR = dir;
    process.env.MAILBOX_MCP_CONFIG_DIR = dir;
    clearSendLimit("personal");
    config = { provider: "gmail", email: "me@example.com", approval: "external" };
    provider = createMockProvider();
    ctx = {
      accountManager: { listAccounts: vi.fn(), getAccount: vi.fn().mockImplementation(() => config) } as any,
      getProvider: vi.fn().mockReturnValue(provider),
    };
  });

  afterEach(() => {
    delete process.env.MAILBOX_MCP_LOG_DIR;
    delete process.env.MAILBOX_MCP_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("send_email writes the resolved message to the queue and sends nothing", async () => {
    const attachment = join(dir, "report.pdf");
    writeFileSync(attachment, "%PDF-1.4 hello");
    const result = await handleToolCall("send_email", {
      account: "personal", to: ["a@example.net"], cc: ["Cee <c@example.net>"], bcc: ["b@example.net"],
      from: "alias@example.com", subject: "Hi", body: "Hello", html: true, attachments: [attachment],
    }, ctx);
    expect(result.isError).toBeUndefined();
    expect(sent(provider)).toBe(0);
    expect(existsSync(join(dir, "sends.jsonl"))).toBe(false);

    const queue = listPending();
    expect(queue).toHaveLength(1);
    const spec = queue[0];
    expect(result.content[0].text).toContain(`Pending id: ${spec.id}`);
    expect(result.content[0].text).toContain(`mailbox-mcp approve ${spec.id}`);
    expect(result.content[0].text).toMatch(/nothing was sent/);
    expect(spec).toMatchObject({
      account: "personal", tool: "send_email", reason: "approval", action: { kind: "send" },
      from: "alias@example.com", to: ["a@example.net"], cc: ["Cee <c@example.net>"], bcc: ["b@example.net"],
      subject: "Hi", body: "Hello", html: true,
      attachments: [{ path: attachment, name: "report.pdf", size: 14 }],
    });
  });

  it("reply_email, forward_email, send_draft and send_template queue instead of sending", async () => {
    vi.mocked(provider.readMessage).mockResolvedValueOnce({ ...ORIGINAL }).mockResolvedValueOnce({ ...ORIGINAL })
      .mockResolvedValueOnce({ ...ORIGINAL, subject: "[TEMPLATE:welcome] Welcome aboard", body: "template body" });
    const reply = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "Thanks", reply_all: true, cc: ["extra@example.org"] }, ctx);
    const forward = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["other@example.com"], message: "FYI" }, ctx);
    const draft = await handleToolCall("send_draft", { account: "personal", draft_id: "d1" }, ctx);
    const template = await handleToolCall("send_template", { account: "personal", message_id: "tpl-1", to: ["x@example.org"] }, ctx);
    for (const r of [reply, forward, draft, template]) {
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toMatch(/Queued for approval, nothing was sent/);
    }
    expect(sent(provider)).toBe(0);
    expect(existsSync(join(dir, "sends.jsonl"))).toBe(false);

    const byTool = Object.fromEntries(listPending().map((s) => [s.tool, s]));
    expect(byTool.reply_email).toMatchObject({
      action: { kind: "reply", messageId: "msg-1", replyAll: true }, subject: "Re: Hello", body: "Thanks",
      to: ["Sender <sender@example.net>", "me@example.com", "peer@example.org", "cc@example.org"], cc: ["extra@example.org"],
    });
    expect(byTool.forward_email).toMatchObject({ action: { kind: "forward", messageId: "msg-1" }, to: ["other@example.com"], subject: "Fwd: Hello", body: "FYI" });
    expect(byTool.send_draft).toMatchObject({ action: { kind: "sendDraft", draftId: "d1", fingerprint: "fp-1" }, to: ["To <draft-to@example.com>", "draft-cc@example.org"] });
    expect(byTool.send_template).toMatchObject({ action: { kind: "send" }, to: ["x@example.org"], subject: "Welcome aboard", body: "template body" });
  });

  it("send_draft refuses to queue when the provider cannot fingerprint the draft", async () => {
    delete (provider as any).draftFingerprint;
    const result = await handleToolCall("send_draft", { account: "personal", draft_id: "d1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot fingerprint the draft/);
    expect(listPending()).toEqual([]);
    expect(provider.sendDraft).not.toHaveBeenCalled();
  });

  it("runs the existing guards first and queues nothing when they refuse", async () => {
    config = { ...config, allowedRecipients: ["@example.com"] };
    const blocked = await handleToolCall("send_email", { account: "personal", to: ["leak@attacker.example"], subject: "s", body: "b", confirm_new_recipient: true }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/allowlist/);

    config = { provider: "gmail", email: "me@example.com", approval: "external" };
    vi.mocked(provider.hasCorrespondedWith!).mockResolvedValue(false);
    const fresh = await handleToolCall("send_email", { account: "personal", to: ["new@example.net"], subject: "s", body: "b" }, ctx);
    expect(fresh.isError).toBe(true);
    expect(fresh.content[0].text).toContain("confirm_new_recipient");

    expect(listPending()).toEqual([]);
    expect(sent(provider)).toBe(0);
  });

  it("draftsOnly wins: a draft is created and nothing is queued", async () => {
    config = { ...config, draftsOnly: true };
    const result = await handleToolCall("send_email", { account: "personal", to: ["a@example.net"], subject: "s", body: "b" }, ctx);
    expect(result.content[0].text).toMatch(/draftsOnly/);
    expect(provider.createDraft).toHaveBeenCalled();
    expect(listPending()).toEqual([]);
  });

  it("readOnly still refuses outright", async () => {
    config = { ...config, readOnly: true };
    const result = await handleToolCall("send_email", { account: "personal", to: ["a@example.net"], subject: "s", body: "b" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/read-only/);
    expect(listPending()).toEqual([]);
  });

  it("create_draft is not a send and is unaffected", async () => {
    const result = await handleToolCall("create_draft", { account: "personal", to: ["a@example.net"], subject: "s", body: "b" }, ctx);
    expect(result.content[0].text).toContain("draft-1");
    expect(listPending()).toEqual([]);
  });

  it("without approval set the same call sends as before", async () => {
    config = { provider: "gmail", email: "me@example.com" };
    const result = await handleToolCall("send_email", { account: "personal", to: ["a@example.net"], subject: "s", body: "b" }, ctx);
    expect(result.content[0].text).toContain("sent-msg-1");
    expect(listPending()).toEqual([]);
    expect(existsSync(join(dir, "pending"))).toBe(false);
  });
});
