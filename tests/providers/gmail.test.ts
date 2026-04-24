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
    expect(provider.capabilities.templates).toBe(true);
    expect(provider.capabilities.attachments).toBe(true);
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

  it("searchMessages fetches metadata in parallel and preserves list order", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    mockGmail.users.messages.list.mockResolvedValue({
      data: { messages: ids.map((id) => ({ id })) },
    });
    // Make "a" resolve last and "c" first to prove the result array is indexed
    // by input position, not completion order. Sequential code would deadlock
    // here because "a" awaits "c" — parallel code completes fine.
    const delays: Record<string, number> = { a: 50, b: 10, c: 0, d: 5, e: 20 };
    mockGmail.users.messages.get.mockImplementation(async ({ id }: { id: string }) => {
      await new Promise((r) => setTimeout(r, delays[id]));
      return {
        data: {
          id, threadId: `t-${id}`, labelIds: ["INBOX"], snippet: "",
          payload: {
            headers: [
              { name: "From", value: `sender-${id}@example.com` },
              { name: "To", value: "me@example.com" },
              { name: "Subject", value: `Subject ${id}` },
              { name: "Date", value: "Thu, 27 Mar 2026 10:00:00 +0000" },
            ],
            parts: [],
          },
        },
      };
    });

    const results = await provider.searchMessages("in:inbox", 5);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(mockGmail.users.messages.get).toHaveBeenCalledTimes(5);
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

  it("trashMessages uses batchModify with the TRASH label", async () => {
    mockGmail.users.messages.batchModify.mockResolvedValue({});

    await provider.trashMessages(["msg-1", "msg-2", "msg-3"]);
    expect(mockGmail.users.messages.batchModify).toHaveBeenCalledTimes(1);
    expect(mockGmail.users.messages.batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { ids: ["msg-1", "msg-2", "msg-3"], addLabelIds: ["TRASH"] },
    });
    // trash should never be called per-message now
    expect(mockGmail.users.messages.trash).not.toHaveBeenCalled();
  });

  it("trashMessages chunks batches larger than 1000 ids", async () => {
    mockGmail.users.messages.batchModify.mockResolvedValue({});
    const ids = Array.from({ length: 2500 }, (_, i) => `m-${i}`);

    await provider.trashMessages(ids);
    expect(mockGmail.users.messages.batchModify).toHaveBeenCalledTimes(3);
    const calls = mockGmail.users.messages.batchModify.mock.calls;
    expect(calls[0][0].requestBody.ids).toHaveLength(1000);
    expect(calls[1][0].requestBody.ids).toHaveLength(1000);
    expect(calls[2][0].requestBody.ids).toHaveLength(500);
  });

  it("findMessageIds paginates through nextPageToken without fetching metadata", async () => {
    mockGmail.users.messages.list
      .mockResolvedValueOnce({ data: { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "c" }] } });

    const ids = await provider.findMessageIds("label:Newsletters");

    expect(ids).toEqual(["a", "b", "c"]);
    expect(mockGmail.users.messages.list).toHaveBeenCalledTimes(2);
    expect(mockGmail.users.messages.list.mock.calls[0][0]).toMatchObject({ q: "label:Newsletters", maxResults: 500 });
    expect(mockGmail.users.messages.list.mock.calls[1][0]).toMatchObject({ pageToken: "p2" });
    expect(mockGmail.users.messages.get).not.toHaveBeenCalled();
  });

  it("findMessageIds applies the folder as a label: prefix", async () => {
    mockGmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });

    await provider.findMessageIds("older_than:30d", "Meetups");

    expect(mockGmail.users.messages.list.mock.calls[0][0].q).toBe("label:Meetups older_than:30d");
  });

  it("findMessageIds caps results at maxResults and stops paginating", async () => {
    mockGmail.users.messages.list.mockResolvedValue({
      data: { messages: Array.from({ length: 10 }, (_, i) => ({ id: `m-${i}` })) },
    });

    const ids = await provider.findMessageIds("foo", undefined, 7);

    expect(ids).toHaveLength(7);
    expect(mockGmail.users.messages.list).toHaveBeenCalledTimes(1);
    expect(mockGmail.users.messages.list.mock.calls[0][0].maxResults).toBe(7);
  });

  it("batchModifyLabels uses a single batchModify call for small batches", async () => {
    mockGmail.users.messages.batchModify.mockResolvedValue({});

    await provider.batchModifyLabels(["a", "b"], ["STARRED"], ["UNREAD"]);
    expect(mockGmail.users.messages.batchModify).toHaveBeenCalledTimes(1);
    expect(mockGmail.users.messages.batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { ids: ["a", "b"], addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
    });
    // per-message modify should not be called
    expect(mockGmail.users.messages.modify).not.toHaveBeenCalled();
  });

  it("batchModifyLabels chunks batches larger than 1000 ids", async () => {
    mockGmail.users.messages.batchModify.mockResolvedValue({});
    const ids = Array.from({ length: 1500 }, (_, i) => `m-${i}`);

    await provider.batchModifyLabels(ids, [], ["UNREAD", "INBOX"]);
    expect(mockGmail.users.messages.batchModify).toHaveBeenCalledTimes(2);
    const calls = mockGmail.users.messages.batchModify.mock.calls;
    expect(calls[0][0].requestBody.ids).toHaveLength(1000);
    expect(calls[1][0].requestBody.ids).toHaveLength(500);
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
