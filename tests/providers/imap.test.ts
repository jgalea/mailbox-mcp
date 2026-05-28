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
    expect(mockImap.messageMove).toHaveBeenCalledWith(1, "Trash", { uid: true });
    expect(mockImap.messageMove).toHaveBeenCalledWith(2, "Trash", { uid: true });
    expect(mockImap.messageMove).toHaveBeenCalledWith(3, "Trash", { uid: true });
  });

  it("trashMessages falls back to standard Trash folder name when no specialUse match", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
    ]);
    mockImap.messageMove.mockResolvedValue(true);

    await provider.trashMessages(["5"]);
    expect(mockImap.messageMove).toHaveBeenCalledWith(5, "Trash", { uid: true });
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
    expect(mockImap.messageMove).toHaveBeenCalledWith(42, "Trash", { uid: true });
    expect(mockImap.messageMove).toHaveBeenCalledWith(99, "Trash", { uid: true });
  });

  it("modifyLabels passes unknown labels through as IMAP keywords", async () => {
    // Per RFC 3501 §2.3.2, server- and user-defined keywords are valid
    // alongside the system flags. We pass them through rather than throwing
    // so workflows depending on custom keywords (e.g. "$Junk", project tags)
    // keep working. The previous behaviour threw on anything not in the
    // system-flag set.
    await provider.modifyLabels("INBOX:7", ["Work"], ["Personal"]);
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(7, ["Work"], { uid: true });
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(7, ["Personal"], { uid: true });
  });

  it("modifyLabels normalises known flag names to canonical title case", async () => {
    await provider.modifyLabels("INBOX:5", ["Seen", "ANSWERED"], ["FLAGGED", "\\Draft"]);
    // Title case regardless of input casing; the leading backslash is added
    // when missing and preserved when present.
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(5, ["\\Seen", "\\Answered"], { uid: true });
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(5, ["\\Flagged", "\\Draft"], { uid: true });
  });

  it("modifyLabels translates UNREAD by inverting against \\Seen", async () => {
    // UNREAD is the logical inverse of \Seen (RFC 3501 §2.3.2): there is no
    // \Unseen flag. Adding UNREAD means removing \Seen, removing UNREAD
    // means adding \Seen. Crossing these so the abstraction matches Gmail's
    // UNREAD vocabulary.
    await provider.modifyLabels("INBOX:9", ["UNREAD"], []);
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(9, ["\\Seen"], { uid: true });
    expect(mockImap.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("modifyLabels translates remove-UNREAD into add \\Seen", async () => {
    await provider.modifyLabels("INBOX:9", [], ["UNREAD"]);
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(9, ["\\Seen"], { uid: true });
    expect(mockImap.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it("modifyLabels maps STARRED to \\Flagged for Gmail parity", async () => {
    // Gmail's cross-provider star vocabulary is STARRED; on IMAP the
    // equivalent is the \Flagged system flag. Mapping here so callers using
    // the abstraction (markRead/starMessage on a generic MailProvider) work
    // the same against both providers.
    await provider.modifyLabels("INBOX:11", ["STARRED"], []);
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(11, ["\\Flagged"], { uid: true });
  });

  it("modifyLabels handles a mix of standard, inverted, custom and Gmail-style names", async () => {
    await provider.modifyLabels("INBOX:13", ["UNREAD", "STARRED", "$Important"], ["Seen", "Project-X"]);
    // UNREAD adds → \Seen remove; STARRED adds → \Flagged add; $Important stays as-is.
    // remove Seen → \Seen remove (joins the UNREAD result); Project-X passes through.
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(13, ["\\Flagged", "$Important"], { uid: true });
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(13, ["\\Seen", "\\Seen", "Project-X"], { uid: true });
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
    // The fetchAll downstream must also use { uid: true } so the UIDs from
    // listRecentUids aren't reinterpreted as sequence numbers.
    expect(mockImap.fetchAll).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      { uid: true }
    );
  });

  it("searchMessages returns ids in folder:uid form", async () => {
    mockImap.search.mockResolvedValue([7]);
    mockImap.fetchAll.mockResolvedValue([
      { uid: 7, envelope: { from: [{ address: "a@x" }], to: [], subject: "x", date: new Date(0) }, bodyStructure: { childNodes: [] } },
    ]);
    const results = await provider.searchMessages("x");
    expect(results[0].id).toBe("INBOX:7");
  });

  it("searchMessages asks the server for UIDs, not sequence numbers", async () => {
    // imapflow's search() returns seq nums without { uid: true }. Without this,
    // the seq nums flow into fetchAll and either fetch the wrong rows or
    // return empty results on a mailbox with expunged messages.
    mockImap.search.mockResolvedValue([42]);
    mockImap.fetchAll.mockResolvedValue([
      { uid: 42, envelope: { from: [{ address: "a@x" }], to: [], subject: "x", date: new Date(0) }, bodyStructure: { childNodes: [] } },
    ]);
    await provider.searchMessages("hello", 10);
    expect(mockImap.search).toHaveBeenCalledWith(
      { or: [{ subject: "hello" }, { body: "hello" }] },
      { uid: true }
    );
    // And the fetchAll must also pass { uid: true } as its third options arg
    // so the returned UIDs aren't reinterpreted as sequence numbers.
    expect(mockImap.fetchAll).toHaveBeenCalledWith(
      [42],
      expect.objectContaining({ envelope: true, uid: true }),
      { uid: true }
    );
  });

  it("inboxSummary returns fresh unread count from server, not cached mailbox.unseen", async () => {
    // mailbox.unseen is populated by imapflow at SELECT time and never
    // refreshed. Marking messages read/unread, IDLE updates, and concurrent
    // changes from other clients don't touch it — the cached value can be
    // arbitrarily stale. We need to ask the server for a fresh count.
    mockImap.mailbox.exists = 100;
    mockImap.mailbox.unseen = 999; // stale — should be ignored
    mockImap.search.mockResolvedValue([10, 11, 12, 13]); // 4 unseen now
    mockImap.fetch.mockImplementation(async function* () {
      yield { uid: 98 };
      yield { uid: 99 };
      yield { uid: 100 };
    });
    mockImap.fetchAll.mockResolvedValue([]);

    const result = await provider.inboxSummary();
    expect(result.unread).toBe(4);
    expect(result.total).toBe(100);
    expect(mockImap.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
  });

  it("inboxSummary reports zero unread when search returns empty array", async () => {
    mockImap.mailbox.exists = 50;
    mockImap.mailbox.unseen = 5;
    mockImap.search.mockResolvedValue([]);
    mockImap.fetch.mockImplementation(async function* () {});
    mockImap.fetchAll.mockResolvedValue([]);

    const result = await provider.inboxSummary();
    expect(result.unread).toBe(0);
  });

  it("inboxSummary tolerates search returning false (some imapflow paths)", async () => {
    mockImap.mailbox.exists = 50;
    mockImap.search.mockResolvedValue(false);
    mockImap.fetch.mockImplementation(async function* () {});
    mockImap.fetchAll.mockResolvedValue([]);

    const result = await provider.inboxSummary();
    expect(result.unread).toBe(0);
  });

  it("messagesSince asks the server for UIDs, not sequence numbers", async () => {
    // Same UID/seq mismatch as searchByText: search() without { uid: true }
    // returns seq nums, fetchAll then treats them as UIDs. Both call sites
    // need { uid: true } so the pipeline is UID-based end to end.
    const since = "2026-05-01T00:00:00Z";
    mockImap.search.mockResolvedValue([17, 23]);
    mockImap.fetchAll.mockResolvedValue([
      { uid: 23, envelope: { from: [{ address: "a@x" }], to: [], subject: "x", date: new Date(0) }, bodyStructure: { childNodes: [] } },
      { uid: 17, envelope: { from: [{ address: "b@x" }], to: [], subject: "y", date: new Date(0) }, bodyStructure: { childNodes: [] } },
    ]);

    const results = await provider.messagesSince(since);
    expect(mockImap.search).toHaveBeenCalledWith(
      { since: expect.any(Date) },
      { uid: true }
    );
    expect(mockImap.fetchAll).toHaveBeenCalledWith(
      [23, 17],
      expect.objectContaining({ envelope: true, uid: true }),
      { uid: true }
    );
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("INBOX:23");
  });

  it("messagesSince returns empty array and skips fetchAll when search has no hits", async () => {
    mockImap.search.mockResolvedValue([]);
    const results = await provider.messagesSince("2026-05-01T00:00:00Z");
    expect(results).toEqual([]);
    expect(mockImap.fetchAll).not.toHaveBeenCalled();
  });

  it("markRead passes uid:true so flag operations target the right message", async () => {
    await provider.markRead("INBOX:101", true);
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(101, ["\\Seen"], { uid: true });
    await provider.markRead("INBOX:101", false);
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(101, ["\\Seen"], { uid: true });
  });

  it("starMessage passes uid:true so flag operations target the right message", async () => {
    await provider.starMessage("INBOX:202", true);
    expect(mockImap.messageFlagsAdd).toHaveBeenCalledWith(202, ["\\Flagged"], { uid: true });
    await provider.starMessage("INBOX:202", false);
    expect(mockImap.messageFlagsRemove).toHaveBeenCalledWith(202, ["\\Flagged"], { uid: true });
  });

  it("archiveMessage passes uid:true to messageMove", async () => {
    mockImap.list.mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Archive", specialUse: "\\Archive" },
    ]);
    await provider.archiveMessage("INBOX:303");
    expect(mockImap.messageMove).toHaveBeenCalledWith(303, "Archive", { uid: true });
  });

  it("readMessage passes uid:true to fetchOne so the right message is returned", async () => {
    mockImap.fetchOne.mockResolvedValue({
      uid: 42,
      envelope: { from: [{ address: "x@y" }], to: [], subject: "s", date: new Date(0) },
      flags: new Set(),
      bodyStructure: undefined,
    });
    await provider.readMessage("INBOX:42");
    // The third arg (FetchOptions) is what tells imapflow to treat 42 as a
    // UID rather than a sequence number. Without it, on a mailbox with
    // expunged messages, fetchOne returns the wrong row (or false).
    expect(mockImap.fetchOne).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ envelope: true, uid: true }),
      { uid: true }
    );
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

  // Regression for #14: imapflow stores the full Content-Type in node.type
  // ("text/plain"), not as separate type+subtype. Verify the body of a
  // multipart/alternative message is extracted in the real imapflow shape.
  it("readMessage extracts body from multipart/alternative in real imapflow bodyStructure shape", async () => {
    const { Readable } = await import("node:stream");
    mockImap.fetchOne.mockResolvedValue({
      uid: 42,
      envelope: {
        from: [{ address: "sender@example.com", name: "Sender" }],
        to: [{ address: "me@example.com" }],
        subject: "Multipart subject",
        date: new Date("2026-03-27T10:00:00Z"),
      },
      flags: new Set(),
      bodyStructure: {
        type: "multipart/alternative",
        childNodes: [
          { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, size: 12 },
          { part: "2", type: "text/html", parameters: { charset: "utf-8" }, size: 24 },
        ],
      },
    });
    mockImap.download.mockImplementation(async (_uid: any, part: string) => {
      if (part === "1") return { meta: {}, content: Readable.from([Buffer.from("Plain body!")]) };
      return { meta: {}, content: Readable.from([Buffer.from("<p>html</p>")]) };
    });

    const out = await provider.readMessage("INBOX:42");
    expect(out.body).toBe("Plain body!");
    expect(mockImap.download).toHaveBeenCalledWith(42, "1", expect.objectContaining({ uid: true }));
  });

  // Regression for #14: attachment MIME type should come from node.type as a full
  // Content-Type string ("application/pdf"), not "application/pdf/undefined".
  it("extractImapAttachments uses node.type as the full MIME type (imapflow shape)", async () => {
    mockImap.fetchOne.mockResolvedValue({
      uid: 7,
      envelope: { from: [{ address: "a@x" }], to: [], subject: "with pdf", date: new Date(0) },
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain", parameters: { charset: "utf-8" } },
          {
            part: "2", type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "1.pdf" },
            size: 4096,
          },
        ],
      },
    });
    mockImap.download.mockResolvedValue({
      meta: {},
      content: (await import("node:stream")).Readable.from([Buffer.from("")]),
    });

    const out = await provider.readMessage("INBOX:7");
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].mimeType).toBe("application/pdf");
    expect(out.attachments[0].filename).toBe("1.pdf");
    expect(out.attachments[0].id).toBe("2");
  });

  // Regression for #16: downloadAttachment should accept the filename as well
  // as the IMAP part path. read_email renders attachments as "1.pdf (2)" so
  // users naturally pass "1.pdf".
  it("downloadAttachment accepts filename in addition to part path", async () => {
    const { Readable } = await import("node:stream");
    mockImap.fetchOne.mockResolvedValue({
      uid: 11,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain" },
          {
            part: "2", type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "1.pdf" },
            size: 4096,
          },
        ],
      },
    });
    mockImap.download.mockResolvedValue({
      meta: { filename: "1.pdf", contentType: "application/pdf" },
      content: Readable.from([Buffer.from("%PDF-1.4")]),
    });

    const out = await provider.downloadAttachment("INBOX:11", "1.pdf");
    expect(out.filename).toBe("1.pdf");
    expect(out.mimeType).toBe("application/pdf");
    // Must fetch by part path "2", not by the filename
    expect(mockImap.download).toHaveBeenCalledWith(11, "2", expect.objectContaining({ uid: true }));
  });

  // Regression for #16: unknown attachment id lists available filenames in the error.
  it("downloadAttachment lists available attachments when the id is unknown", async () => {
    mockImap.fetchOne.mockResolvedValue({
      uid: 12,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            part: "2", type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "real.pdf" },
            size: 4096,
          },
        ],
      },
    });

    await expect(provider.downloadAttachment("INBOX:12", "missing.pdf"))
      .rejects.toThrow(/not found.*real\.pdf/i);
  });

  // Regression for #15: non-ASCII queries that return empty from the server
  // should fall back to a client-side envelope scan.
  it("searchMessages falls back to client-side scan for non-ASCII queries when server returns empty", async () => {
    mockImap.mailbox.exists = 3;
    mockImap.search.mockResolvedValue([]); // server returns nothing for Cyrillic
    mockImap.fetch.mockImplementation(async function* () {
      yield { seq: 1, uid: 101, envelope: { from: [{ address: "a@x" }], subject: "invoice", to: [] } };
      yield { seq: 2, uid: 102, envelope: { from: [{ address: "b@x" }], subject: "Срочно: расчётного периода", to: [] } };
      yield { seq: 3, uid: 103, envelope: { from: [{ address: "c@x" }], subject: "newsletter", to: [] } };
    });
    mockImap.fetchAll.mockResolvedValue([
      {
        uid: 102,
        envelope: { from: [{ address: "b@x" }], to: [], subject: "Срочно: расчётного периода", date: new Date(0) },
        bodyStructure: { childNodes: [] },
      },
    ]);

    const results = await provider.searchMessages("расчётного");
    expect(results).toHaveLength(1);
    expect(results[0].subject).toContain("расчётного");
  });

  // Latin-only queries should NOT trigger the client-side scan even if the
  // server returns empty — server emptiness for Latin is legitimate.
  it("searchMessages does not fall back to client-side scan for ASCII queries", async () => {
    mockImap.search.mockResolvedValue([]);
    mockImap.fetchAll.mockResolvedValue([]);
    const results = await provider.searchMessages("invoice");
    expect(results).toEqual([]);
    expect(mockImap.fetch).not.toHaveBeenCalled();
  });
});
