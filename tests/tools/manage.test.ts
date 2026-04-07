import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleToolCall, sanitizeErrorMessage, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import { redactTokens } from "../../src/security/sanitize.js";
import "../../src/tools/manage.js";

function createMockProvider(): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, snooze: true, templates: true, signatures: true, vacation: true, contacts: true, unsubscribe: true, attachments: true, inboxSummary: true },
    listLabels: vi.fn().mockResolvedValue([{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Work", type: "user" }]),
    createLabel: vi.fn().mockResolvedValue({ id: "Label_2", name: "New", type: "user" }),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
    modifyLabels: vi.fn().mockResolvedValue(undefined),
    batchModifyLabels: vi.fn().mockResolvedValue(undefined),
    trashMessages: vi.fn().mockResolvedValue(undefined),
  } as unknown as MailProvider;
}

describe("manage tools", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    mockProvider = createMockProvider();
    ctx = { accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any, getProvider: vi.fn().mockReturnValue(mockProvider) };
  });

  it("list_labels returns labels", async () => {
    const result = await handleToolCall("list_labels", { account: "personal" }, ctx);
    expect(result.content[0].text).toContain("INBOX");
    expect(result.content[0].text).toContain("Work");
  });

  it("create_label creates and returns new label", async () => {
    const result = await handleToolCall("create_label", { account: "personal", name: "New" }, ctx);
    expect(result.content[0].text).toContain("New");
  });

  it("trash_emails trashes messages", async () => {
    const result = await handleToolCall("trash_emails", { account: "personal", message_ids: ["msg-1", "msg-2"] }, ctx);
    expect(mockProvider.trashMessages).toHaveBeenCalledWith(["msg-1", "msg-2"]);
    expect(result.content[0].text).toContain("2");
  });

  it("modify_email modifies labels", async () => {
    await handleToolCall("modify_email", { account: "personal", message_id: "msg-1", add_labels: ["Work"], remove_labels: ["INBOX"] }, ctx);
    expect(mockProvider.modifyLabels).toHaveBeenCalledWith("msg-1", ["Work"], ["INBOX"]);
  });
});

describe("sanitizeErrorMessage", () => {
  it("strips absolute file paths from error messages", () => {
    const msg = "ENOENT: no such file or directory, open '/home/user/.mailbox-mcp/accounts/foo/token.json'";
    const result = sanitizeErrorMessage(msg, redactTokens);
    expect(result).not.toContain("/home/user/");
    expect(result).toContain("[path]/");
  });

  it("redacts OAuth tokens alongside path stripping", () => {
    const msg = "Failed to refresh ya29.a0AfH6SMBx1234567890abcdef at /var/app/src/auth.js";
    const result = sanitizeErrorMessage(msg, redactTokens);
    expect(result).not.toContain("ya29");
    expect(result).not.toContain("/var/app/");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("[path]/");
  });

  it("leaves normal error messages unchanged", () => {
    const msg = "Account not found";
    expect(sanitizeErrorMessage(msg, redactTokens)).toBe("Account not found");
  });
});
