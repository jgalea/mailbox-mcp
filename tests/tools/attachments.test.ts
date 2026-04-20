import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleToolCall, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import "../../src/tools/attachments.js";

describe("attachment tools", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    mockProvider = {
      type: "gmail",
      capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
      downloadAttachment: vi.fn().mockResolvedValue({ filename: "invoice.pdf", data: Buffer.from("fake-pdf"), mimeType: "application/pdf" }),
    } as unknown as MailProvider;
    ctx = { accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any, getProvider: vi.fn().mockReturnValue(mockProvider) };
  });

  it("download_attachment saves to safe directory", async () => {
    const result = await handleToolCall("download_attachment", { account: "personal", message_id: "msg-1", attachment_id: "att-1", save_to: "/tmp/mailbox-mcp-test" }, ctx);
    expect(result.content[0].text).toContain("invoice.pdf");
  });

  it("blocks path traversal in filename", async () => {
    (mockProvider.downloadAttachment as any).mockResolvedValue({ filename: "../../etc/passwd", data: Buffer.from("evil"), mimeType: "text/plain" });
    const result = await handleToolCall("download_attachment", { account: "personal", message_id: "msg-1", attachment_id: "att-1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("traversal");
  });

  it("blocks saving to disallowed directories", async () => {
    const result = await handleToolCall("download_attachment", { account: "personal", message_id: "msg-1", attachment_id: "att-1", save_to: "/etc/cron.d" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowed");
  });

  it("blocks saving to home directory root via traversal", async () => {
    const result = await handleToolCall("download_attachment", { account: "personal", message_id: "msg-1", attachment_id: "att-1", save_to: "/tmp/../etc" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowed");
  });
});
