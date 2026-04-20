import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImapProvider } from "../../src/providers/imap.js";

function createMockImapClient() {
  return {
    connect: vi.fn(),
    logout: vi.fn(),
    search: vi.fn(),
    fetch: vi.fn(),
    fetchOne: vi.fn(),
    fetchAll: vi.fn(),
    download: vi.fn(),
    messageDelete: vi.fn(),
    messageFlagsAdd: vi.fn(),
    messageFlagsRemove: vi.fn(),
    messageMove: vi.fn(),
    mailboxCreate: vi.fn(),
    mailboxDelete: vi.fn(),
    list: vi.fn(),
    mailboxOpen: vi.fn(),
    append: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    on: vi.fn(),
    mailbox: { exists: 0, unseen: 0 },
  };
}

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: "<test@example.com>" }),
  };
}

describe("ImapProvider", () => {
  let mockImap: ReturnType<typeof createMockImapClient>;
  let mockTransport: ReturnType<typeof createMockTransport>;
  let provider: ImapProvider;

  beforeEach(() => {
    mockImap = createMockImapClient();
    mockTransport = createMockTransport();
    provider = new ImapProvider(mockImap as any, mockTransport as any, "test@example.com");
  });

  it("has correct type and capabilities", () => {
    expect(provider.type).toBe("imap");
    expect(provider.capabilities.threads).toBe(false);
    expect(provider.capabilities.filters).toBe(false);
    expect(provider.capabilities.attachments).toBe(true);
    expect(provider.capabilities.inboxSummary).toBe(true);
  });

  it("searchMessages queries IMAP and returns summaries", async () => {
    mockImap.search.mockResolvedValue([1, 2]);
    mockImap.fetchAll.mockResolvedValue([
      {
        uid: 1,
        envelope: {
          from: [{ address: "sender@example.com", name: "Sender" }],
          to: [{ address: "me@example.com", name: "Me" }],
          subject: "Test email",
          date: new Date("2026-03-27T10:00:00Z"),
          messageId: "<abc@example.com>",
        },
        flags: new Set(),
        bodyStructure: { childNodes: [] },
      },
    ]);

    const results = await provider.searchMessages("Test");
    expect(results).toHaveLength(1);
    expect(results[0].from).toContain("sender@example.com");
    expect(results[0].subject).toBe("Test email");
  });

  it("sendMessage uses SMTP transport", async () => {
    const id = await provider.sendMessage(["recipient@example.com"], "Hello", "Body text");
    expect(mockTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "test@example.com",
        to: "recipient@example.com",
        subject: "Hello",
      })
    );
    expect(id).toContain("test@example.com");
  });

  it("listLabels returns IMAP folders as labels", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox", flags: new Set() },
      { path: "Sent", specialUse: "\\Sent", flags: new Set() },
      { path: "Work", specialUse: undefined, flags: new Set() },
    ]);

    const labels = await provider.listLabels();
    expect(labels).toHaveLength(3);
    expect(labels[0]).toEqual({ id: "INBOX", name: "INBOX", type: "system" });
    expect(labels[2]).toEqual({ id: "Work", name: "Work", type: "user" });
  });

  it("trashMessages uses discovered trash folder", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Trash", specialUse: "\\Trash" },
    ]);
    mockImap.messageMove.mockResolvedValue(true);

    await provider.trashMessages(["1", "2", "3"]);
    expect(mockImap.messageMove).toHaveBeenCalledWith(1, "Trash");
    expect(mockImap.messageMove).toHaveBeenCalledWith(2, "Trash");
    expect(mockImap.messageMove).toHaveBeenCalledWith(3, "Trash");
  });

  it("trashMessages falls back to standard Trash folder name when no specialUse match", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
    ]);
    mockImap.messageMove.mockResolvedValue(true);

    await provider.trashMessages(["5"]);
    expect(mockImap.messageMove).toHaveBeenCalledWith(5, "Trash");
  });

  it("trashMessages processes sequentially", async () => {
    mockImap.list.mockResolvedValue([{ path: "[Gmail]/Trash", specialUse: "\\Trash" }]);
    const order: number[] = [];
    mockImap.messageMove.mockImplementation(async (uid: any) => {
      order.push(typeof uid === "string" ? parseInt(uid) : uid);
      return true;
    });

    await provider.trashMessages(["1", "2", "3"]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("createDraft uses discovered drafts folder", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Drafts", specialUse: "\\Drafts" },
    ]);
    mockImap.append.mockResolvedValue(undefined);

    const id = await provider.createDraft(["a@b.com"], "Test subject", "Draft body");
    expect(id).toMatch(/^draft-/);
    expect(mockImap.getMailboxLock).toHaveBeenCalledWith("Drafts");
    expect(mockImap.append).toHaveBeenCalledWith("Drafts", expect.any(Buffer), ["\\Draft"]);
  });

  it("createDraft falls back to standard Drafts folder name when no specialUse match", async () => {
    mockImap.list.mockResolvedValue([{ path: "INBOX", specialUse: "\\Inbox" }]);
    mockImap.append.mockResolvedValue(undefined);

    await provider.createDraft([], "subj", "body");
    expect(mockImap.append).toHaveBeenCalledWith("Drafts", expect.any(Buffer), ["\\Draft"]);
  });

  it("findSpecialFolder caches results to avoid repeated list calls", async () => {
    mockImap.list.mockResolvedValue([{ path: "[Gmail]/Trash", specialUse: "\\Trash" }]);
    mockImap.messageMove.mockResolvedValue(true);

    // Call trashMessages twice — list should only be called once due to cache
    await provider.trashMessages(["1"]);
    await provider.trashMessages(["2"]);
    expect(mockImap.list).toHaveBeenCalledTimes(1);
  });

  it("trashMessages locks the source folder encoded in compound message ids", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Trash", specialUse: "\\Trash" },
    ]);
    mockImap.messageMove.mockResolvedValue(true);

    await provider.trashMessages(["Sent:42", "Archive:99"]);
    // Each source folder should have been locked exactly once.
    const lockedFolders = mockImap.getMailboxLock.mock.calls.map(([folder]: any) => folder);
    expect(lockedFolders).toContain("Sent");
    expect(lockedFolders).toContain("Archive");
    expect(mockImap.messageMove).toHaveBeenCalledWith(42, "Trash");
    expect(mockImap.messageMove).toHaveBeenCalledWith(99, "Trash");
  });

  it("modifyLabels rejects non-flag label names", async () => {
    await expect(provider.modifyLabels("1", ["Work"], [])).rejects.toThrow(/not a recognized IMAP flag/i);
    await expect(provider.modifyLabels("1", [], ["INBOX"])).rejects.toThrow(/not a recognized IMAP flag/i);
  });

  it("modifyLabels normalises known flag names and applies them", async () => {
    await provider.modifyLabels("INBOX:5", ["Seen"], ["Flagged"]);
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(5, ["\\Seen"]);
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(5, ["\\Flagged"]);
  });

  it("searchMessages with empty query uses recent-UID fallback instead of searching", async () => {
    mockImap.mailbox.exists = 3;
    mockImap.fetch.mockImplementation(async function* () {
      yield { uid: 1 };
      yield { uid: 2 };
      yield { uid: 3 };
    });
    mockImap.fetchAll.mockResolvedValue([
      { uid: 3, envelope: { from: [{ address: "a@x", name: "A" }], subject: "s", date: new Date(0), to: [] }, bodyStructure: { childNodes: [] } },
    ]);

    await provider.searchMessages("", 5);
    expect(mockImap.search).not.toHaveBeenCalled();
    expect(mockImap.fetch).toHaveBeenCalled();
  });

  it("searchMessages returns ids in folder:uid form", async () => {
    mockImap.search.mockResolvedValue([7]);
    mockImap.fetchAll.mockResolvedValue([
      { uid: 7, envelope: { from: [{ address: "a@x" }], to: [], subject: "x", date: new Date(0) }, bodyStructure: { childNodes: [] } },
    ]);
    const results = await provider.searchMessages("x");
    expect(results[0].id).toBe("INBOX:7");
  });

  it("downloadAttachment resolves filename and mime type from bodyStructure", async () => {
    const { Readable } = await import("node:stream");
    mockImap.fetchOne.mockResolvedValue({
      uid: 10,
      bodyStructure: {
        childNodes: [
          {
            part: "2", type: "application", subtype: "pdf",
            disposition: "attachment",
            parameters: { name: "invoice.pdf" },
            size: 4096,
          },
        ],
      },
    });
    mockImap.download.mockResolvedValue({
      meta: { filename: "invoice.pdf", contentType: "application/pdf" },
      content: Readable.from([Buffer.from("%PDF-1.4")]),
    });

    const out = await provider.downloadAttachment("INBOX:10", "2");
    expect(out.filename).toBe("invoice.pdf");
    expect(out.mimeType).toBe("application/pdf");
    expect(out.data.toString()).toBe("%PDF-1.4");
  });
});
