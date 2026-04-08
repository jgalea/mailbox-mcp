import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleToolCall, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import "../../src/tools/write.js";

function createMockProvider(): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, snooze: true, templates: true, signatures: true, vacation: true, contacts: true, unsubscribe: true, attachments: true, inboxSummary: true },
    sendMessage: vi.fn().mockResolvedValue("sent-msg-1"),
    replyToMessage: vi.fn().mockResolvedValue("reply-msg-1"),
    forwardMessage: vi.fn().mockResolvedValue("fwd-msg-1"),
    createDraft: vi.fn().mockResolvedValue("draft-1"),
  } as unknown as MailProvider;
}

describe("write tools", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    mockProvider = createMockProvider();
    ctx = { accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any, getProvider: vi.fn().mockReturnValue(mockProvider) };
  });

  it("send_email sends and returns message ID", async () => {
    const result = await handleToolCall("send_email", { account: "personal", to: ["test@test.com"], subject: "Hi", body: "Hello" }, ctx);
    expect(result.content[0].text).toContain("sent-msg-1");
    expect(mockProvider.sendMessage).toHaveBeenCalledWith(["test@test.com"], "Hi", "Hello", expect.anything());
  });

  it("reply_email replies and returns message ID", async () => {
    const result = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "Thanks" }, ctx);
    expect(result.content[0].text).toContain("reply-msg-1");
  });

  it("forward_email forwards and returns message ID", async () => {
    const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["other@test.com"] }, ctx);
    expect(result.content[0].text).toContain("fwd-msg-1");
  });

  it("create_draft creates and returns draft ID", async () => {
    const result = await handleToolCall("create_draft", { account: "personal", to: ["test@test.com"], subject: "Draft", body: "WIP" }, ctx);
    expect(result.content[0].text).toContain("draft-1");
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
        { account: "personal", to: ["a@b.com"], subject: "s", body: "b", attachments: [pdfPath] },
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
        { account: "personal", message_id: "m1", to: ["c@d.com"], attachments: [pdfPath] },
        ctx,
      );
      const call = (mockProvider.forwardMessage as any).mock.calls[0];
      expect(call[2].attachments).toHaveLength(1);
    });

    it("create_draft forwards attachments to the provider", async () => {
      await handleToolCall(
        "create_draft",
        { account: "personal", to: ["a@b.com"], subject: "s", body: "b", attachments: [pdfPath] },
        ctx,
      );
      const call = (mockProvider.createDraft as any).mock.calls[0];
      expect(call[3].attachments).toHaveLength(1);
    });

    it("surfaces a clear error when the attachment path is missing", async () => {
      const result = await handleToolCall(
        "send_email",
        { account: "personal", to: ["a@b.com"], subject: "s", body: "b", attachments: ["/no/such/file.pdf"] },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Attachment not found/);
    });
  });
});
