// tests/providers/jmap.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JmapProvider } from "../../src/providers/jmap.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockSessionResponse() {
  return {
    ok: true,
    json: async () => ({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
      uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
      accounts: { "u1234": { name: "test@fastmail.com", isPersonal: true } },
      primaryAccounts: { "urn:ietf:params:jmap:mail": "u1234" },
    }),
  };
}

function mockApiResponse(methodResponses: any[]) {
  return {
    ok: true,
    json: async () => ({ methodResponses }),
  };
}

describe("JmapProvider", () => {
  let provider: JmapProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new JmapProvider("fastmail.com", "test@fastmail.com", "testuser", "testpass");
  });

  it("has correct type and capabilities", () => {
    expect(provider.type).toBe("jmap");
    expect(provider.capabilities.threads).toBe(true);
    expect(provider.capabilities.attachments).toBe(true);
    expect(provider.capabilities.inboxSummary).toBe(true);
    expect(provider.capabilities.filters).toBe(false);
    expect(provider.capabilities.signatures).toBe(false);
    expect(provider.capabilities.vacation).toBe(false);
  });

  it("discovers session on first API call", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/query", { ids: ["m1"] }, "0"],
        ["Email/get", { list: [{
          id: "m1", threadId: "t1",
          from: [{ name: "Sender", email: "sender@example.com" }],
          to: [{ name: "Me", email: "test@fastmail.com" }],
          subject: "Test", preview: "Hello world",
          receivedAt: "2026-03-31T10:00:00Z",
          mailboxIds: { "inbox-id": true },
          hasAttachment: false,
        }] }, "1"],
      ]));

    const results = await provider.searchMessages("Test");
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe("Test");
    expect(results[0].from).toContain("sender@example.com");

    // Verify session discovery was called
    expect(mockFetch).toHaveBeenCalledWith(
      "https://fastmail.com/.well-known/jmap",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringContaining("Basic") }),
      })
    );
  });

  it("caches session after first discovery", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/query", { ids: [] }, "0"],
        ["Email/get", { list: [] }, "1"],
      ]))
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/query", { ids: [] }, "0"],
        ["Email/get", { list: [] }, "1"],
      ]));

    await provider.searchMessages("first");
    await provider.searchMessages("second");

    const sessionCalls = mockFetch.mock.calls.filter(
      (c: any) => c[0].includes(".well-known")
    );
    expect(sessionCalls).toHaveLength(1);
  });

  it("readMessage returns full email with fenced content", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/get", { list: [{
          id: "m1", threadId: "t1",
          from: [{ name: "Sender", email: "sender@example.com" }],
          to: [{ name: "Me", email: "test@fastmail.com" }],
          cc: [{ email: "cc@example.com" }],
          bcc: [],
          replyTo: [{ email: "reply@example.com" }],
          subject: "Important",
          preview: "Preview text",
          receivedAt: "2026-03-31T10:00:00Z",
          mailboxIds: { "inbox-id": true },
          hasAttachment: true,
          textBody: [{ partId: "1" }],
          bodyValues: { "1": { value: "Hello there" } },
          attachments: [{ blobId: "b1", name: "doc.pdf", type: "application/pdf", size: 1024 }],
        }] }, "0"],
      ]));

    const msg = await provider.readMessage("m1");
    expect(msg.id).toBe("m1");
    expect(msg.body).toContain("Hello there");
    expect(msg.body).toContain("[UNTRUSTED_EMAIL_CONTENT]");
    expect(msg.subject).toContain("[UNTRUSTED_SUBJECT]");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].filename).toBe("doc.pdf");
  });

  it("readThread returns native thread with multiple messages", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Thread/get", { list: [{ id: "t1", emailIds: ["m1", "m2"] }] }, "0"],
        ["Email/get", { list: [
          {
            id: "m1", threadId: "t1",
            from: [{ email: "a@example.com" }], to: [{ email: "b@example.com" }],
            subject: "Thread subject", preview: "First",
            receivedAt: "2026-03-31T09:00:00Z",
            mailboxIds: {}, hasAttachment: false,
            textBody: [{ partId: "1" }], bodyValues: { "1": { value: "First message" } },
            attachments: [],
          },
          {
            id: "m2", threadId: "t1",
            from: [{ email: "b@example.com" }], to: [{ email: "a@example.com" }],
            subject: "Re: Thread subject", preview: "Second",
            receivedAt: "2026-03-31T10:00:00Z",
            mailboxIds: {}, hasAttachment: false,
            textBody: [{ partId: "1" }], bodyValues: { "1": { value: "Second message" } },
            attachments: [],
          },
        ] }, "1"],
      ]));

    const thread = await provider.readThread("t1");
    expect(thread.id).toBe("t1");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0].body).toContain("First message");
    expect(thread.messages[1].body).toContain("Second message");
  });

  it("inboxSummary returns counts and recent messages", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      // Step 1: Find inbox mailbox
      .mockResolvedValueOnce(mockApiResponse([
        ["Mailbox/query", { ids: ["mbox-inbox"] }, "0"],
        ["Mailbox/get", { list: [{ id: "mbox-inbox", name: "Inbox", role: "inbox", totalEmails: 42, unreadEmails: 5 }] }, "1"],
      ]))
      // Step 2: Get recent emails from inbox
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/query", { ids: ["m1"] }, "0"],
        ["Email/get", { list: [{
          id: "m1", threadId: "t1",
          from: [{ email: "sender@example.com" }],
          to: [{ email: "test@fastmail.com" }],
          subject: "Recent", preview: "Latest",
          receivedAt: "2026-03-31T10:00:00Z",
          mailboxIds: { "mbox-inbox": true },
          hasAttachment: false,
        }] }, "1"],
      ]));

    const summary = await provider.inboxSummary();
    expect(summary.total).toBe(42);
    expect(summary.unread).toBe(5);
    expect(summary.recent).toHaveLength(1);
  });

  it("sendMessage creates and submits an email", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/set", { created: { "draft0": { id: "m-new" } } }, "0"],
        ["EmailSubmission/set", { created: { "sub0": { id: "s1" } } }, "1"],
      ]));
    const id = await provider.sendMessage(["to@example.com"], "Hello", "Body text");
    expect(id).toBe("m-new");
    const apiCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    const emailSet = apiCall.methodCalls[0];
    expect(emailSet[0]).toBe("Email/set");
    const created = emailSet[1].create.draft0;
    expect(created.to).toEqual([{ email: "to@example.com" }]);
    expect(created.subject).toBe("Hello");
  });

  it("sendMessage includes cc and bcc when provided", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/set", { created: { "draft0": { id: "m-cc" } } }, "0"],
        ["EmailSubmission/set", { created: { "sub0": {} } }, "1"],
      ]));
    await provider.sendMessage(["to@example.com"], "Test", "Body", {
      cc: ["cc@example.com"], bcc: ["bcc@example.com"],
    });
    const apiCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    const created = apiCall.methodCalls[0][1].create.draft0;
    expect(created.cc).toEqual([{ email: "cc@example.com" }]);
    expect(created.bcc).toEqual([{ email: "bcc@example.com" }]);
  });

  it("replyToMessage fetches original and sends reply", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/get", { list: [{
          id: "m-orig", threadId: "t1",
          from: [{ email: "original@example.com" }],
          to: [{ email: "test@fastmail.com" }],
          cc: [], bcc: [], replyTo: [],
          subject: "Original", preview: "",
          receivedAt: "2026-03-31T10:00:00Z",
          mailboxIds: {}, hasAttachment: false,
          textBody: [{ partId: "1" }],
          bodyValues: { "1": { value: "Original body" } },
          attachments: [],
        }] }, "0"],
      ]))
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/set", { created: { "draft0": { id: "m-reply" } } }, "0"],
        ["EmailSubmission/set", { created: { "sub0": {} } }, "1"],
      ]));
    const id = await provider.replyToMessage("m-orig", "Reply body");
    expect(id).toBe("m-reply");
  });

  it("createDraft creates email in drafts mailbox", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Mailbox/query", { ids: ["mbox-drafts"] }, "0"],
        ["Mailbox/get", { list: [{ id: "mbox-drafts", name: "Drafts", role: "drafts" }] }, "1"],
      ]))
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/set", { created: { "draft0": { id: "d-new" } } }, "0"],
      ]));
    const id = await provider.createDraft(["to@example.com"], "Draft Subject", "Draft body");
    expect(id).toBe("d-new");
  });

  it("trashMessages moves emails to trash mailbox", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Mailbox/query", { ids: ["mbox-trash"] }, "0"],
        ["Mailbox/get", { list: [{ id: "mbox-trash", name: "Trash", role: "trash" }] }, "1"],
      ]))
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/set", { updated: { "m1": null, "m2": null } }, "0"],
      ]));
    await provider.trashMessages(["m1", "m2"]);
    const apiCall = JSON.parse(mockFetch.mock.calls[2][1].body);
    const emailSet = apiCall.methodCalls[0];
    expect(emailSet[0]).toBe("Email/set");
    expect(emailSet[1].update.m1.mailboxIds).toEqual({ "mbox-trash": true });
    expect(emailSet[1].update.m2.mailboxIds).toEqual({ "mbox-trash": true });
  });

  it("listLabels returns mailboxes as labels", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Mailbox/get", { list: [
          { id: "mbox-inbox", name: "Inbox", role: "inbox" },
          { id: "mbox-sent", name: "Sent", role: "sent" },
          { id: "mbox-custom", name: "Projects", role: null },
        ] }, "0"],
      ]));
    const labels = await provider.listLabels();
    expect(labels).toHaveLength(3);
    expect(labels[0]).toEqual({ id: "mbox-inbox", name: "Inbox", type: "system" });
    expect(labels[2]).toEqual({ id: "mbox-custom", name: "Projects", type: "user" });
  });

  it("createLabel creates a new mailbox", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Mailbox/set", { created: { "mbox0": { id: "mbox-new" } } }, "0"],
      ]));
    const label = await provider.createLabel("New Label");
    expect(label).toEqual({ id: "mbox-new", name: "New Label", type: "user" });
  });

  it("deleteLabel destroys a mailbox", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Mailbox/set", { destroyed: ["mbox-del"] }, "0"],
      ]));
    await provider.deleteLabel("mbox-del");
    const apiCall = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(apiCall.methodCalls[0][1].destroy).toEqual(["mbox-del"]);
  });

  it("downloadAttachment fetches blob", async () => {
    mockFetch
      .mockResolvedValueOnce(mockSessionResponse())
      .mockResolvedValueOnce(mockApiResponse([
        ["Email/get", { list: [{
          id: "m1", threadId: "t1",
          from: [{ email: "a@b.com" }], to: [{ email: "test@fastmail.com" }],
          subject: "With attachment", preview: "",
          receivedAt: "2026-03-31T10:00:00Z",
          mailboxIds: {}, hasAttachment: true,
          textBody: [{ partId: "1" }], bodyValues: { "1": { value: "" } },
          cc: [], bcc: [], replyTo: [],
          attachments: [{ blobId: "blob-1", name: "file.pdf", type: "application/pdf", size: 2048 }],
        }] }, "0"],
      ]))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    const result = await provider.downloadAttachment("m1", "blob-1");
    expect(result.filename).toBe("file.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.data).toBeInstanceOf(Buffer);
  });
});
