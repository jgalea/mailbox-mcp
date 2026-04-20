import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { registerTool } from "./registry.js";
import { validateAttachmentPath } from "../security/validation.js";
import { DEFAULT_DOWNLOAD_DIR, validateSavePath } from "../security/save-path.js";

registerTool(
  {
    name: "export_email",
    description: "Export an email as a raw RFC 822 .eml file to a safe directory. Useful for archival, legal discovery, or migration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID" },
        save_to: { type: "string", description: `Directory to save to (default ~/Downloads/mailbox-mcp). Allowed: ~/Downloads/mailbox-mcp or /tmp.` },
      },
      required: ["account", "message_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const result = await provider.exportMessage(args.message_id as string);

    validateAttachmentPath(result.filename);

    const dir = (args.save_to as string) ?? DEFAULT_DOWNLOAD_DIR;
    validateSavePath(dir);

    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }

    const filePath = join(dir, result.filename);
    writeFileSync(filePath, result.data, { mode: 0o600 });
    chmodSync(filePath, 0o600);

    return { content: [{ type: "text", text: `Exported "${result.filename}" (${result.data.length} bytes) to ${filePath}` }] };
  }
);

registerTool(
  {
    name: "export_thread",
    description: "Export all messages in a thread as individual .eml files to a safe directory. Gmail/JMAP only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        thread_id: { type: "string", description: "Thread ID" },
        save_to: { type: "string", description: `Directory to save to (default ~/Downloads/mailbox-mcp). Allowed: ~/Downloads/mailbox-mcp or /tmp.` },
      },
      required: ["account", "thread_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const thread = await provider.readThread(args.thread_id as string);

    const dir = (args.save_to as string) ?? DEFAULT_DOWNLOAD_DIR;
    validateSavePath(dir);
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }

    const written: string[] = [];
    for (const msg of thread.messages) {
      const exported = await provider.exportMessage(msg.id);
      validateAttachmentPath(exported.filename);
      const filePath = join(dir, exported.filename);
      writeFileSync(filePath, exported.data, { mode: 0o600 });
      chmodSync(filePath, 0o600);
      written.push(filePath);
    }
    return { content: [{ type: "text", text: `Exported ${written.length} messages from thread ${args.thread_id}:\n${written.join("\n")}` }] };
  },
  "threads"
);
