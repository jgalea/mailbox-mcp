import { describe, it, expect, vi } from "vitest";
import { getAllToolDefinitions, handleToolCall, TOOL_ANNOTATIONS, type ToolContextInput } from "../../src/tools/registry.js";
import "../../src/tools/account.js";
import "../../src/tools/read.js";
import "../../src/tools/write.js";
import "../../src/tools/manage.js";
import "../../src/tools/gmail-only.js";
import "../../src/tools/attachments.js";
import "../../src/tools/actions.js";
import "../../src/tools/export.js";

const READ_TOOLS = [
  "list_accounts", "search_emails", "multi_account_search", "read_email", "read_thread", "inbox_summary",
  "emails_since", "count_unread_by_label", "list_drafts", "list_labels", "list_recent_bulk_ops",
  "list_filters", "list_templates", "get_signature", "get_vacation", "list_send_as",
];
const WRITE_TOOLS = [
  "send_email", "reply_email", "forward_email", "send_draft", "send_template", "create_draft", "update_draft",
  "delete_draft", "mark_read", "star_email", "archive_email", "modify_email", "batch_modify_emails",
  "trash_emails", "create_label", "delete_label", "bulk_modify", "bulk_trash", "undo_bulk_op",
  "create_filter", "delete_filter", "save_template", "delete_template", "set_signature", "set_vacation",
  "remove_account", "authenticate", "reauth", "download_attachment", "export_email", "export_thread",
];

describe("tool annotations", () => {
  it("every registered tool carries all four hints", () => {
    delete process.env.MAILBOX_MCP_TOOLS;
    const defs = getAllToolDefinitions();
    expect(defs.length).toBe(49);
    for (const def of defs) {
      const a = def.annotations;
      expect(a, def.name).toBeDefined();
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof a?.[key], `${def.name}.${key}`).toBe("boolean");
      }
    }
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(defs.map((d) => d.name).sort());
  });

  it("marks read tools read-only and write tools not", () => {
    const byName = new Map(getAllToolDefinitions().map((d) => [d.name, d.annotations!]));
    for (const name of READ_TOOLS) expect(byName.get(name)?.readOnlyHint, name).toBe(true);
    for (const name of WRITE_TOOLS) expect(byName.get(name)?.readOnlyHint, name).toBe(false);
  });

  it("marks sends, deletes, trash, bulk, filters, vacation and signature as destructive", () => {
    const byName = new Map(getAllToolDefinitions().map((d) => [d.name, d.annotations!]));
    for (const name of ["send_email", "reply_email", "forward_email", "send_draft", "send_template", "trash_emails", "bulk_trash", "bulk_modify", "delete_filter", "delete_label", "delete_draft", "delete_template", "set_vacation", "set_signature", "remove_account"]) {
      expect(byName.get(name)?.destructiveHint, name).toBe(true);
    }
    for (const name of ["send_email", "reply_email", "forward_email", "send_draft", "send_template"]) {
      expect(byName.get(name)?.openWorldHint, name).toBe(true);
    }
  });
});

describe("read-only accounts", () => {
  const provider = {
    type: "gmail",
    capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
    searchMessages: vi.fn().mockResolvedValue([]),
    readMessage: vi.fn().mockResolvedValue({ id: "m1", from: "a@example.com", to: ["me@example.com"], subject: "s", snippet: "", date: "d", labels: [], hasAttachments: false, body: "b", cc: [], bcc: [], attachments: [] }),
    sendMessage: vi.fn().mockResolvedValue("sent"),
    trashMessages: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    createDraft: vi.fn().mockResolvedValue("d1"),
    hasCorrespondedWith: vi.fn().mockResolvedValue(true),
  };
  const ctx: ToolContextInput = {
    accountManager: {
      listAccounts: vi.fn().mockReturnValue({ ro: { provider: "gmail", email: "me@example.com", readOnly: true } }),
      getAccount: vi.fn().mockImplementation((alias: string) => {
        if (alias === "ro") return { provider: "gmail", email: "me@example.com", readOnly: true };
        return { provider: "gmail", email: "me@example.com" };
      }),
    } as any,
    getProvider: vi.fn().mockResolvedValue(provider),
  };

  it("refuses every write tool with a clear error", async () => {
    for (const [name, args] of [
      ["send_email", { account: "ro", to: ["a@example.com"], subject: "s", body: "b", confirm_new_recipient: true }],
      ["trash_emails", { account: "ro", message_ids: ["m1"] }],
      ["mark_read", { account: "ro", message_id: "m1" }],
      ["create_draft", { account: "ro", to: ["a@example.com"], subject: "s", body: "b" }],
      ["bulk_trash", { account: "ro", query: "x" }],
      ["create_filter", { account: "ro", from: "x" }],
    ] as const) {
      const result = await handleToolCall(name, args as any, ctx);
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(/read-only/);
    }
    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect(provider.trashMessages).not.toHaveBeenCalled();
    expect(provider.markRead).not.toHaveBeenCalled();
    expect(provider.createDraft).not.toHaveBeenCalled();
  });

  it("keeps reads working", async () => {
    const search = await handleToolCall("search_emails", { account: "ro", query: "x" }, ctx);
    expect(search.isError).toBeUndefined();
    const read = await handleToolCall("read_email", { account: "ro", message_id: "m1" }, ctx);
    expect(read.isError).toBeUndefined();
    expect(read.content[0].text).toContain("UNTRUSTED_EMAIL_CONTENT_");
  });

  it("leaves other accounts unaffected", async () => {
    const result = await handleToolCall("mark_read", { account: "rw", message_id: "m1" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(provider.markRead).toHaveBeenCalled();
  });

  it("shows the flag in list_accounts", async () => {
    const result = await handleToolCall("list_accounts", {}, ctx);
    expect(result.content[0].text).toContain("[read-only]");
  });
});
