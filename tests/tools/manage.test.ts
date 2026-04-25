import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { handleToolCall, sanitizeErrorMessage, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import { redactTokens } from "../../src/security/sanitize.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the transaction log at a per-test-run temp dir so we never touch
// the real ~/.mailbox-mcp/transactions.jsonl.
const TX_TMP = mkdtempSync(join(tmpdir(), "mailbox-mcp-test-"));
process.env.MAILBOX_MCP_LOG_DIR = TX_TMP;

import "../../src/tools/manage.js";

function createMockProvider(): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
    listLabels: vi.fn().mockResolvedValue([{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Work", type: "user" }]),
    createLabel: vi.fn().mockResolvedValue({ id: "Label_2", name: "New", type: "user" }),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
    modifyLabels: vi.fn().mockResolvedValue(undefined),
    batchModifyLabels: vi.fn().mockResolvedValue(undefined),
    trashMessages: vi.fn().mockResolvedValue(undefined),
    findMessageIds: vi.fn().mockResolvedValue([]),
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

  it("bulk_trash searches and trashes matching messages", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["a", "b", "c"]);
    const result = await handleToolCall("bulk_trash", { account: "personal", query: "label:Newsletters" }, ctx);
    expect(mockProvider.findMessageIds).toHaveBeenCalledWith("label:Newsletters", undefined, undefined);
    expect(mockProvider.trashMessages).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(result.content[0].text).toContain("3");
  });

  it("bulk_trash with dry_run reports the count without trashing", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["a", "b", "c", "d"]);
    const result = await handleToolCall("bulk_trash", { account: "personal", query: "label:Meetups", dry_run: true }, ctx);
    expect(mockProvider.trashMessages).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("4");
    expect(result.content[0].text).toContain("dry run");
  });

  it("bulk_trash forwards folder and max into the search", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["a"]);
    await handleToolCall("bulk_trash", { account: "personal", query: "older_than:90d", folder: "Updates", max: 500 }, ctx);
    expect(mockProvider.findMessageIds).toHaveBeenCalledWith("older_than:90d", "Updates", 500);
  });

  it("bulk_trash skips the trash call when nothing matches", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue([]);
    const result = await handleToolCall("bulk_trash", { account: "personal", query: "from:nobody@example.com" }, ctx);
    expect(mockProvider.trashMessages).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("No messages matched");
  });

  it("bulk_modify archives matching messages by removing the INBOX label", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["a", "b", "c"]);
    const result = await handleToolCall("bulk_modify", { account: "personal", query: "in:inbox older_than:30d", remove_labels: ["INBOX"] }, ctx);
    expect(mockProvider.findMessageIds).toHaveBeenCalledWith("in:inbox older_than:30d", undefined, undefined);
    expect(mockProvider.batchModifyLabels).toHaveBeenCalledWith(["a", "b", "c"], [], ["INBOX"]);
    expect(result.content[0].text).toContain("3");
    expect(result.content[0].text).toContain("removed [INBOX]");
  });

  it("bulk_modify supports adding and removing labels at once", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["m1"]);
    await handleToolCall("bulk_modify", { account: "personal", query: "label:Inbox is:unread", add_labels: ["Archive"], remove_labels: ["INBOX", "UNREAD"] }, ctx);
    expect(mockProvider.batchModifyLabels).toHaveBeenCalledWith(["m1"], ["Archive"], ["INBOX", "UNREAD"]);
  });

  it("bulk_modify with dry_run reports the count without modifying", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["a", "b"]);
    const result = await handleToolCall("bulk_modify", { account: "personal", query: "label:Newsletters", remove_labels: ["INBOX"], dry_run: true }, ctx);
    expect(mockProvider.batchModifyLabels).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("2");
    expect(result.content[0].text).toContain("dry run");
  });

  it("bulk_modify refuses when neither add_labels nor remove_labels supplied", async () => {
    const result = await handleToolCall("bulk_modify", { account: "personal", query: "label:Foo" }, ctx);
    expect(mockProvider.findMessageIds).not.toHaveBeenCalled();
    expect(mockProvider.batchModifyLabels).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("bulk_modify forwards folder and max into the search", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["x"]);
    await handleToolCall("bulk_modify", { account: "personal", query: "older_than:90d", folder: "Updates", max: 1000, remove_labels: ["INBOX"] }, ctx);
    expect(mockProvider.findMessageIds).toHaveBeenCalledWith("older_than:90d", "Updates", 1000);
  });
});

describe("transaction log and undo", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    // Wipe the temp transaction log between tests for isolation.
    const txFile = join(TX_TMP, "transactions.jsonl");
    if (existsSync(txFile)) rmSync(txFile);
    mockProvider = createMockProvider();
    ctx = { accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any, getProvider: vi.fn().mockReturnValue(mockProvider) };
  });

  afterAll(() => {
    rmSync(TX_TMP, { recursive: true, force: true });
  });

  it("bulk_modify records a transaction and undo_bulk_op reverses it", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["m1", "m2", "m3"]);
    const archive = await handleToolCall("bulk_modify", { account: "personal", query: "in:inbox older_than:30d", remove_labels: ["INBOX"] }, ctx);

    // Op id is included in the response so the user can undo immediately.
    const opIdMatch = archive.content[0].text.match(/id=([a-f0-9]+)/);
    expect(opIdMatch).not.toBeNull();
    const opId = opIdMatch![1];

    // List shows the op.
    const list = await handleToolCall("list_recent_bulk_ops", { account: "personal" }, ctx);
    expect(list.content[0].text).toContain(opId);
    expect(list.content[0].text).toContain("count=3");
    expect(list.content[0].text).toContain("-[INBOX]");

    // Undo replays the inverse against the exact ids.
    const undo = await handleToolCall("undo_bulk_op", { op_id: opId }, ctx);
    expect(undo.content[0].text).toContain("Reversed");
    expect(mockProvider.batchModifyLabels).toHaveBeenLastCalledWith(["m1", "m2", "m3"], ["INBOX"], []);
  });

  it("bulk_trash records TRASH as the added label so undo removes it", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["t1", "t2"]);
    const trashed = await handleToolCall("bulk_trash", { account: "personal", query: "label:Junk" }, ctx);
    const opId = trashed.content[0].text.match(/id=([a-f0-9]+)/)![1];

    const undo = await handleToolCall("undo_bulk_op", { op_id: opId }, ctx);
    expect(undo.content[0].text).toContain("Reversed");
    // Undo of trash = remove the TRASH label.
    expect(mockProvider.batchModifyLabels).toHaveBeenLastCalledWith(["t1", "t2"], [], ["TRASH"]);
  });

  it("undo_bulk_op refuses to re-reverse an already-reversed op", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["m1"]);
    const result = await handleToolCall("bulk_modify", { account: "personal", query: "x", remove_labels: ["INBOX"] }, ctx);
    const opId = result.content[0].text.match(/id=([a-f0-9]+)/)![1];

    await handleToolCall("undo_bulk_op", { op_id: opId }, ctx);
    const second = await handleToolCall("undo_bulk_op", { op_id: opId }, ctx);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("already reversed");
  });

  it("undo_bulk_op returns an error for an unknown op id", async () => {
    const result = await handleToolCall("undo_bulk_op", { op_id: "deadbeef00000000" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("list_recent_bulk_ops filters by account", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["m1"]);
    await handleToolCall("bulk_modify", { account: "personal", query: "x", remove_labels: ["INBOX"] }, ctx);
    await handleToolCall("bulk_modify", { account: "work", query: "y", remove_labels: ["INBOX"] }, ctx);

    const personalOnly = await handleToolCall("list_recent_bulk_ops", { account: "personal" }, ctx);
    expect(personalOnly.content[0].text).toContain("personal bulk_modify");
    expect(personalOnly.content[0].text).not.toContain("work bulk_modify");
  });

  it("dry_run does not record a transaction", async () => {
    (mockProvider.findMessageIds as any).mockResolvedValue(["m1", "m2"]);
    await handleToolCall("bulk_modify", { account: "personal", query: "x", remove_labels: ["INBOX"], dry_run: true }, ctx);
    const list = await handleToolCall("list_recent_bulk_ops", {}, ctx);
    expect(list.content[0].text).toContain("No bulk operations recorded yet.");
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
