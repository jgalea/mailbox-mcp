import { describe, it, expect, vi, beforeEach } from "vitest";
import { GmailProvider } from "../../src/providers/gmail.js";

function createMockGmail() {
  return {
    users: {
      messages: {
        list: vi.fn(),
        get: vi.fn(),
        send: vi.fn(),
        trash: vi.fn(),
        modify: vi.fn(),
        batchModify: vi.fn(),
        attachments: { get: vi.fn() },
      },
      threads: { get: vi.fn() },
      labels: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      drafts: { create: vi.fn() },
      settings: {
        filters: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
        sendAs: { list: vi.fn() },
        getVacation: vi.fn(),
        updateVacation: vi.fn(),
      },
    },
  };
}

describe("GmailProvider", () => {
  let mockGmail: ReturnType<typeof createMockGmail>;
  let provider: GmailProvider;

  beforeEach(() => {
    mockGmail = createMockGmail();
    provider = new GmailProvider(mockGmail as any);
  });

  it("has correct type and capabilities", () => {
    expect(provider.type).toBe("gmail");
    expect(provider.capabilities.threads).toBe(true);
    expect(provider.capabilities.filters).toBe(true);
    expect(provider.capabilities.snooze).toBe(true);
  });

  it("searchMessages returns EmailSummary array", async () => {
    mockGmail.users.messages.list.mockResolvedValue({
      data: { messages: [{ id: "msg-1", threadId: "thread-1" }] },
    });
    mockGmail.users.messages.get.mockResolvedValue({
      data: {
        id: "msg-1", threadId: "thread-1", labelIds: ["INBOX"], snippet: "Hello there",
        payload: {
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "me@example.com" },
            { name: "Subject", value: "Test email" },
            { name: "Date", value: "Thu, 27 Mar 2026 10:00:00 +0000" },
          ],
          parts: [],
        },
      },
    });

    const results = await provider.searchMessages("in:inbox", 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("msg-1");
    expect(results[0].from).toBe("sender@example.com");
    expect(results[0].subject).toBe("Test email");
  });

  it("readMessage returns raw EmailMessage (fencing applied at MCP exit)", async () => {
    mockGmail.users.messages.get.mockResolvedValue({
      data: {
        id: "msg-1", threadId: "thread-1", labelIds: ["INBOX"], snippet: "Hello",
        payload: {
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "me@example.com" },
            { name: "Subject", value: "Test" },
            { name: "Date", value: "Thu, 27 Mar 2026 10:00:00 +0000" },
            { name: "Cc", value: "" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("Hello world").toString("base64url") } },
          ],
        },
      },
    });

    const msg = await provider.readMessage("msg-1");
    expect(msg.body).toBe("Hello world");
    expect(msg.subject).toBe("Test");
  });

  it("trashMessages processes sequentially", async () => {
    const order: string[] = [];
    mockGmail.users.messages.trash.mockImplementation(async (args: any) => {
      order.push(args.id);
      return {};
    });

    await provider.trashMessages(["msg-1", "msg-2", "msg-3"]);
    expect(order).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(mockGmail.users.messages.trash).toHaveBeenCalledTimes(3);
  });

  describe("outbound attachments", () => {
    const pdfAttachment = {
      filename: "report.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4\nhello"),
    };

    it("sendMessage uses media upload when attachments are present", async () => {
      mockGmail.users.messages.send.mockResolvedValue({ data: { id: "sent-1" } });
      const id = await provider.sendMessage(["x@y.com"], "s", "b", { attachments: [pdfAttachment] });
      expect(id).toBe("sent-1");
      const call = mockGmail.users.messages.send.mock.calls[0][0];
      expect(call.media).toBeDefined();
      expect(call.media.mimeType).toBe("message/rfc822");
      // media.body must be a Readable stream (googleapis requirement for media uploads)
      expect(typeof call.media.body.pipe).toBe("function");
      expect(call.requestBody.raw).toBeUndefined();
      // Raw body should contain the attachment filename in a Content-Disposition header
      const bodyChunks: Buffer[] = [];
      for await (const chunk of call.media.body as AsyncIterable<Buffer>) bodyChunks.push(chunk);
      const bodyStr = Buffer.concat(bodyChunks).toString();
      expect(bodyStr).toContain("report.pdf");
      expect(bodyStr).toContain("multipart/mixed");
    });

    it("sendMessage still uses raw base64 path for small plain emails", async () => {
      mockGmail.users.messages.send.mockResolvedValue({ data: { id: "sent-2" } });
      await provider.sendMessage(["x@y.com"], "s", "b");
      const call = mockGmail.users.messages.send.mock.calls[0][0];
      expect(call.media).toBeUndefined();
      expect(typeof call.requestBody.raw).toBe("string");
    });

    it("createDraft uses media upload when attachments are present and preserves threadId", async () => {
      mockGmail.users.drafts.create.mockResolvedValue({ data: { id: "draft-1" } });
      const id = await provider.createDraft(["x@y.com"], "s", "b", { attachments: [pdfAttachment] });
      expect(id).toBe("draft-1");
      const call = mockGmail.users.drafts.create.mock.calls[0][0];
      expect(call.media).toBeDefined();
      expect(call.media.mimeType).toBe("message/rfc822");
      expect(call.requestBody.message.raw).toBeUndefined();
    });
  });

  it("listLabels returns Label array", async () => {
    mockGmail.users.labels.list.mockResolvedValue({
      data: {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "Label_1", name: "Work", type: "user" },
        ],
      },
    });

    const labels = await provider.listLabels();
    expect(labels).toHaveLength(2);
    expect(labels[0]).toEqual({ id: "INBOX", name: "INBOX", type: "system" });
    expect(labels[1]).toEqual({ id: "Label_1", name: "Work", type: "user" });
  });
});
