import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MailProvider, ProviderCapabilities } from "../providers/interface.js";
import type { AccountManager } from "../accounts.js";

export interface ToolContext {
  accountManager: AccountManager;
  getProvider: (alias: string) => MailProvider | Promise<MailProvider>;
  clearProviderCache?: (alias: string) => void;
}

export interface ToolHandler {
  (args: Record<string, unknown>, ctx: ToolContext): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

interface RegisteredTool {
  definition: Tool;
  handler: ToolHandler;
  requiredCapability?: keyof ProviderCapabilities;
}

const tools: RegisteredTool[] = [];

export function registerTool(
  definition: Tool,
  handler: ToolHandler,
  requiredCapability?: keyof ProviderCapabilities
): void {
  if (tools.some(t => t.definition.name === definition.name)) {
    throw new Error(`Tool "${definition.name}" is already registered`);
  }
  tools.push({ definition, handler, requiredCapability });
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

export function getAllToolDefinitions(): Tool[] {
  return tools.filter((t) => isToolEnabled(t.definition.name)).map((t) => t.definition);
}

export function sanitizeErrorMessage(message: string, redactTokens: (s: string) => string): string {
  return redactTokens(message).replace(/\/[^\s:,'"]+\//g, "[path]/");
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
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

  try {
    return await tool.handler(args, ctx);
  } catch (error) {
    const { redactTokens } = await import("../security/sanitize.js");
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: sanitizeErrorMessage(message, redactTokens) }], isError: true };
  }
}
