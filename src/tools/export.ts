import { registerTool, lookupAccount } from "./registry.js";
import { markTainted } from "../security/taint.js";
import { validateAttachmentPath } from "../security/validation.js";
import { DEFAULT_DOWNLOAD_DIR, saveFile } from "../security/save-path.js";

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
    // The raw message leaves the fence entirely, sender unknown, so the lock treats it as untrusted content.
    markTainted(args.account as string, lookupAccount(ctx, args.account as string), "export_email", `exported message ${args.message_id}`);

    validateAttachmentPath(result.filename);
    const filePath = saveFile((args.save_to as string) ?? DEFAULT_DOWNLOAD_DIR, result.filename, result.data);

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
    markTainted(args.account as string, lookupAccount(ctx, args.account as string), "export_thread", `exported thread ${args.thread_id}`);

    const dir = (args.save_to as string) ?? DEFAULT_DOWNLOAD_DIR;
    const written: string[] = [];
    for (const msg of thread.messages) {
      const exported = await provider.exportMessage(msg.id);
      validateAttachmentPath(exported.filename);
      written.push(saveFile(dir, exported.filename, exported.data));
    }
    return { content: [{ type: "text", text: `Exported ${written.length} messages from thread ${args.thread_id}:\n${written.join("\n")}` }] };
  },
  "threads"
);
