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

export function getAllToolDefinitions(): Tool[] {
  return tools.map((t) => t.definition);
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
