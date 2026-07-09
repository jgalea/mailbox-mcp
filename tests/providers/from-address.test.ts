import { describe, it, expect, vi, beforeEach } from "vitest";
import { GmailProvider, buildEmailBuffer } from "../../src/providers/gmail.js";
import { extractAddress } from "../../src/providers/headers.js";

function sendAsList(...aliases: { email: string; primary?: boolean; pending?: boolean }[]) {
  return {
    data: {
      sendAs: aliases.map((a) => ({
        sendAsEmail: a.email,
        isPrimary: a.primary,
        verificationStatus: a.pending ? "pending" : "accepted",
      })),
    },
  };
}

function createMockGmail() {
  return {
    users: {
      messages: { get: vi.fn(), send: vi.fn().mockResolvedValue({ data: { id: "sent-1" } }) },
      drafts: { create: vi.fn().mockResolvedValue({ data: { id: "draft-1" } }) },
      settings: { sendAs: { list: vi.fn() } },
    },
  };
}

describe("extractAddress", () => {
  it("pulls the addr-spec out of a display-name header", () => {
    expect(extractAddress("Alias Owner <alias@example.com>")).toBe("alias@example.com");
  });

  it("passes through a bare address", () => {
    expect(extractAddress("alias@example.com")).toBe("alias@example.com");
  });

  it("lowercases so alias matching is case-insensitive", () => {
    expect(extractAddress("Alias <Alias@Example.com>")).toBe("alias@example.com");
  });

  it("handles a quoted display name containing angle brackets", () => {
    expect(extractAddress('"Doe, Jane" <alias@example.com>')).toBe("alias@example.com");
  });
});

describe("buildEmailBuffer", () => {
  it("emits a From header when from is supplied", () => {
    const raw = buildEmailBuffer(["a@b.com"], "Hi", "Body", { from: "alias@example.com" }).toString("utf-8");
    expect(raw).toContain("From: alias@example.com");
  });

  it("omits the From header when from is absent, so Gmail uses the primary", () => {
    const raw = buildEmailBuffer(["a@b.com"], "Hi", "Body", {}).toString("utf-8");
    expect(raw).not.toContain("From:");
  });

  it("strips CRLF from from, so an injected Bcc never becomes its own header line", () => {
    const raw = buildEmailBuffer(["a@b.com"], "Hi", "Body", {
      from: "alias@example.com\r\nBcc: attacker@evil.com",
    }).toString("utf-8");
    // The payload is flattened into the From value rather than starting a new header.
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw.split("\r\n").filter((l) => l.startsWith("From:"))).toHaveLength(1);
  });
});

describe("GmailProvider send-as validation", () => {
  let mockGmail: ReturnType<typeof createMockGmail>;
  let provider: GmailProvider;

  beforeEach(() => {
    mockGmail = createMockGmail();
    provider = new GmailProvider(mockGmail as any);
  });

  it("sends with the From header when the alias is verified", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(
      sendAsList({ email: "primary@example.com", primary: true }, { email: "alias@example.com" }),
    );
    await provider.sendMessage(["a@b.com"], "Hi", "Body", { from: "alias@example.com" });

    const raw = Buffer.from(
      mockGmail.users.messages.send.mock.calls[0][0].requestBody.raw,
      "base64url",
    ).toString("utf-8");
    expect(raw).toContain("From: alias@example.com");
  });

  it("rejects an address that is not a send-as alias, listing what is allowed", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(
      sendAsList({ email: "primary@example.com", primary: true }, { email: "alias@example.com" }),
    );
    await expect(
      provider.sendMessage(["a@b.com"], "Hi", "Body", { from: "someone@else.com" }),
    ).rejects.toThrow(/Cannot send as "someone@else\.com".*primary@example\.com, alias@example\.com/s);
    expect(mockGmail.users.messages.send).not.toHaveBeenCalled();
  });

  it("rejects a pending (unverified) alias, which Gmail would silently rewrite", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(
      sendAsList({ email: "primary@example.com", primary: true }, { email: "unverified@x.com", pending: true }),
    );
    await expect(
      provider.sendMessage(["a@b.com"], "Hi", "Body", { from: "unverified@x.com" }),
    ).rejects.toThrow(/Cannot send as/);
  });

  it("accepts a display-name form of a verified alias", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(sendAsList({ email: "alias@example.com" }));
    await expect(
      provider.sendMessage(["a@b.com"], "Hi", "Body", { from: "Alias Owner <alias@example.com>" }),
    ).resolves.toBe("sent-1");
  });

  it("does not call the send-as API when from is omitted", async () => {
    await provider.sendMessage(["a@b.com"], "Hi", "Body", {});
    expect(mockGmail.users.settings.sendAs.list).not.toHaveBeenCalled();
  });

  it("caches the alias list across sends", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(sendAsList({ email: "alias@example.com" }));
    await provider.sendMessage(["a@b.com"], "Hi", "One", { from: "alias@example.com" });
    await provider.sendMessage(["a@b.com"], "Hi", "Two", { from: "alias@example.com" });
    expect(mockGmail.users.settings.sendAs.list).toHaveBeenCalledTimes(1);
  });

  it("validates before replying, and puts From on the reply", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(sendAsList({ email: "alias@example.com" }));
    mockGmail.users.messages.get.mockResolvedValue({
      data: {
        threadId: "t1",
        payload: {
          headers: [
            { name: "From", value: "amazon@example.com" },
            { name: "Subject", value: "Order" },
            { name: "Message-ID", value: "<m1@example.com>" },
          ],
        },
      },
    });
    await provider.replyToMessage("m1", "Reply body", { from: "alias@example.com" });

    const raw = Buffer.from(
      mockGmail.users.messages.send.mock.calls[0][0].requestBody.raw,
      "base64url",
    ).toString("utf-8");
    expect(raw).toContain("From: alias@example.com");
    expect(raw).toContain("To: amazon@example.com");
  });

  it("blocks a reply from an unverified address before reading the original", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(sendAsList({ email: "alias@example.com" }));
    await expect(provider.replyToMessage("m1", "Body", { from: "nope@x.com" })).rejects.toThrow(/Cannot send as/);
    expect(mockGmail.users.messages.send).not.toHaveBeenCalled();
  });

  it("puts From on a created draft", async () => {
    mockGmail.users.settings.sendAs.list.mockResolvedValue(sendAsList({ email: "alias@example.com" }));
    await provider.createDraft(["a@b.com"], "Subj", "Body", { from: "alias@example.com" });

    const raw = Buffer.from(
      mockGmail.users.drafts.create.mock.calls[0][0].requestBody.message.raw,
      "base64url",
    ).toString("utf-8");
    expect(raw).toContain("From: alias@example.com");
  });
});
