import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { MailProvider, ProviderCapabilities } from "../providers/interface.js";
import type { AccountConfig, AccountManager } from "../accounts.js";
import { ResponseFence } from "../security/sanitize.js";
import { noteSenders } from "../security/taint.js";

export interface ToolContext {
  accountManager: AccountManager;
  getProvider: (alias: string) => MailProvider | Promise<MailProvider>;
  clearProviderCache?: (alias: string) => void;
  /** Per-response fence; the registry creates one for every call. */
  fence: ResponseFence;
}

export type ToolContextInput = Omit<ToolContext, "fence"> & { fence?: ResponseFence };

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface ToolHandler {
  (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

interface RegisteredTool {
  definition: Tool;
  handler: ToolHandler;
  requiredCapability?: keyof ProviderCapabilities;
}

const tools: RegisteredTool[] = [];

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SEND: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DELETE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const LOCAL_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Every tool must appear here; registerTool refuses one that does not, so a
// new tool cannot ship without saying whether it writes. readOnlyHint also
// drives the per-account read-only mode.
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  list_accounts: READ,
  authenticate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  reauth: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  remove_account: DELETE,
  search_emails: READ, multi_account_search: READ, read_email: READ, read_thread: READ,
  inbox_summary: READ, emails_since: READ, count_unread_by_label: READ,
  send_email: SEND, reply_email: SEND, forward_email: SEND, send_draft: SEND, send_template: SEND,
  create_draft: CREATE, update_draft: UPDATE, delete_draft: DELETE, list_drafts: READ,
  mark_read: UPDATE, star_email: UPDATE, archive_email: UPDATE,
  modify_email: UPDATE, batch_modify_emails: UPDATE,
  trash_emails: DELETE,
  list_labels: READ, create_label: CREATE, delete_label: DELETE,
  bulk_modify: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  bulk_trash: DELETE, list_recent_bulk_ops: READ, undo_bulk_op: UPDATE,
  download_attachment: LOCAL_WRITE, export_email: LOCAL_WRITE, export_thread: LOCAL_WRITE,
  list_filters: READ, create_filter: CREATE, delete_filter: DELETE,
  save_template: CREATE, list_templates: READ, delete_template: DELETE,
  get_signature: READ, set_signature: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  get_vacation: READ, set_vacation: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  unsubscribe: READ, bulk_unsubscribe: READ,
  list_send_as: READ,
};

export function registerTool(
  definition: Tool,
  handler: ToolHandler,
  requiredCapability?: keyof ProviderCapabilities
): void {
  if (tools.some(t => t.definition.name === definition.name)) {
    throw new Error(`Tool "${definition.name}" is already registered`);
  }
  const annotations = TOOL_ANNOTATIONS[definition.name];
  if (!annotations) {
    throw new Error(`Tool "${definition.name}" has no entry in TOOL_ANNOTATIONS`);
  }
  tools.push({ definition: { ...definition, annotations }, handler, requiredCapability });
}

// Tool groups selectable via MAILBOX_MCP_TOOLS (comma-separated group names).
// Unset or empty means every group is exposed. "core" covers the everyday
// search/read/send/draft flow — in real usage it accounts for the vast
// majority of calls, and trimming to it cuts the schema payload roughly in half.
export const TOOL_GROUPS: Record<string, string> = {
  list_accounts: "core", authenticate: "core", reauth: "core", remove_account: "core",
  search_emails: "core", multi_account_search: "core", read_email: "core", read_thread: "core",
  send_email: "core", reply_email: "core", forward_email: "core",
  create_draft: "core", list_drafts: "core", send_draft: "core", update_draft: "core", delete_draft: "core",
  inbox_summary: "core", emails_since: "core", mark_read: "core",
  list_labels: "organize", create_label: "organize", delete_label: "organize",
  modify_email: "organize", batch_modify_emails: "organize", star_email: "organize",
  archive_email: "organize", trash_emails: "organize", count_unread_by_label: "organize",
  bulk_modify: "bulk", bulk_trash: "bulk", list_recent_bulk_ops: "bulk", undo_bulk_op: "bulk",
  download_attachment: "attachments", export_email: "attachments", export_thread: "attachments",
  create_filter: "gmail-extras", list_filters: "gmail-extras", delete_filter: "gmail-extras",
  save_template: "gmail-extras", list_templates: "gmail-extras", delete_template: "gmail-extras",
  send_template: "gmail-extras", get_signature: "gmail-extras", set_signature: "gmail-extras",
  get_vacation: "gmail-extras", set_vacation: "gmail-extras",
  unsubscribe: "gmail-extras", bulk_unsubscribe: "gmail-extras", list_send_as: "gmail-extras",
};

function enabledGroups(): Set<string> | null {
  const raw = process.env.MAILBOX_MCP_TOOLS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean));
}

function isToolEnabled(name: string): boolean {
  const groups = enabledGroups();
  if (!groups) return true;
  return groups.has(TOOL_GROUPS[name] ?? "core");
}

// Per-instance tool profile, selected with MAILBOX_MCP_PROFILE. Composes with
// MAILBOX_MCP_TOOLS: a tool is exposed only when both allow it. "read" is
// exactly the tools annotated readOnlyHint; "draft" is everything except the
// tools below, which can make mail leave the account or change what future
// mail says to a third party.
export type ToolProfile = "full" | "draft" | "read";

export const DRAFT_PROFILE_EXCLUDED = new Set([
  "send_email", "reply_email", "forward_email", "send_draft", "send_template",
  "create_filter", "set_vacation", "set_signature", "unsubscribe", "bulk_unsubscribe",
]);

export function activeProfile(): ToolProfile {
  const raw = (process.env.MAILBOX_MCP_PROFILE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "full") return "full";
  if (raw === "draft" || raw === "read") return raw;
  throw new Error(`MAILBOX_MCP_PROFILE must be "full", "draft" or "read" (got "${process.env.MAILBOX_MCP_PROFILE}").`);
}

function isAllowedByProfile(name: string, profile: ToolProfile): boolean {
  if (profile === "read") return TOOL_ANNOTATIONS[name]?.readOnlyHint === true;
  if (profile === "draft") return !DRAFT_PROFILE_EXCLUDED.has(name);
  return true;
}

function profileRefusal(name: string, profile: ToolProfile): ToolResult {
  const why = profile === "read" ? "exposes read-only tools only" : "hides every tool that can make mail leave the account";
  return {
    content: [{ type: "text", text: `Tool "${name}" is not available: this server runs with MAILBOX_MCP_PROFILE="${profile}", which ${why}. The profile is set in the server's environment and cannot be changed from here.` }],
    isError: true,
  };
}

export function getAllToolDefinitions(): Tool[] {
  const profile = activeProfile();
  return tools
    .filter((t) => isToolEnabled(t.definition.name) && isAllowedByProfile(t.definition.name, profile))
    .map((t) => t.definition);
}

export function sanitizeErrorMessage(message: string, redactTokens: (s: string) => string): string {
  return redactTokens(message).replace(/\/[^\s:,'"]+\//g, "[path]/");
}

export function lookupAccount(ctx: ToolContext, alias: string): AccountConfig | undefined {
  try {
    return ctx.accountManager.getAccount(alias) ?? undefined;
  } catch {
    return undefined;
  }
}

export function readOnlyRefusal(alias: string): ToolResult {
  return {
    content: [{ type: "text", text: `Refused: account "${alias}" is configured read-only (readOnly: true in accounts.json). Reads work; nothing can be sent, changed, or deleted from here.` }],
    isError: true,
  };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  input: ToolContextInput
): Promise<ToolResult> {
  const ctx: ToolContext = { ...input, fence: input.fence ?? new ResponseFence() };
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  if (!isToolEnabled(name)) {
    return {
      content: [{
        type: "text",
        text: `Tool "${name}" is disabled: its group "${TOOL_GROUPS[name]}" is not in MAILBOX_MCP_TOOLS (currently "${process.env.MAILBOX_MCP_TOOLS}").`,
      }],
      isError: true,
    };
  }
  const profile = activeProfile();
  if (!isAllowedByProfile(name, profile)) return profileRefusal(name, profile);

  const alias = typeof args.account === "string" ? args.account : undefined;
  if (alias && tool.definition.annotations?.readOnlyHint !== true && lookupAccount(ctx, alias)?.readOnly) {
    return readOnlyRefusal(alias);
  }

  if (tool.requiredCapability && args.account) {
    const provider = await ctx.getProvider(args.account as string);
    if (!provider.capabilities[tool.requiredCapability]) {
      return {
        content: [{
          type: "text",
          text: `${provider.type.toUpperCase()} accounts don't support ${tool.requiredCapability}.`,
        }],
        isError: true,
      };
    }
  }

  let result: ToolResult;
  try {
    result = await tool.handler(args, ctx);
  } catch (error) {
    const { redactTokens } = await import("../security/sanitize.js");
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: sanitizeErrorMessage(message, redactTokens) }], isError: true };
  }

  // Tools without an account argument that render senders (multi_account_search)
  // call noteSenders per account themselves.
  if (alias && ctx.fence.evidence.length > 0) {
    noteSenders(alias, lookupAccount(ctx, alias), name, ctx.fence.evidence);
  }

  const warnings = ctx.fence.warnings();
  if (warnings.length > 0 && result.content.length > 0) {
    const last = result.content[result.content.length - 1];
    result.content[result.content.length - 1] = { ...last, text: `${last.text}\n\n${warnings.join("\n")}` };
  }
  return result;
}
