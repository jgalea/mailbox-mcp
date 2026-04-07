import { describe, it, expect } from "vitest";
import type {
  MailProvider,
  ProviderCapabilities,
  EmailSummary,
  EmailMessage,
} from "../../src/providers/interface.js";

describe("MailProvider interface", () => {
  it("ProviderCapabilities has all required fields", () => {
    const caps: ProviderCapabilities = {
      threads: true,
      filters: true,
      snooze: true,
      templates: true,
      signatures: true,
      vacation: true,
      contacts: true,
      unsubscribe: true,
      attachments: true,
      inboxSummary: true,
    };
    expect(Object.keys(caps)).toHaveLength(10);
  });

  it("EmailSummary has required fields", () => {
    const summary: EmailSummary = {
      id: "msg-1",
      from: "test@example.com",
      to: ["recipient@example.com"],
      subject: "Test",
      snippet: "Hello...",
      date: "2026-03-27T10:00:00Z",
      labels: ["INBOX"],
      hasAttachments: false,
    };
    expect(summary.id).toBe("msg-1");
  });

  it("EmailMessage extends EmailSummary", () => {
    const msg: EmailMessage = {
      id: "msg-1",
      from: "test@example.com",
      to: ["recipient@example.com"],
      subject: "Test",
      snippet: "Hello...",
      date: "2026-03-27T10:00:00Z",
      labels: ["INBOX"],
      hasAttachments: false,
      body: "Hello world",
      cc: [],
      bcc: [],
      attachments: [],
    };
    expect(msg.body).toBe("Hello world");
  });
});
