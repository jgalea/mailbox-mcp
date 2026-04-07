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

  it("readMessage returns fenced EmailMessage", async () => {
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
    expect(msg.body).toContain("[UNTRUSTED_EMAIL_CONTENT]");
    expect(msg.body).toContain("Hello world");
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
