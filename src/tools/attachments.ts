import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { registerTool } from "./registry.js";
import { validateAttachmentPath } from "../security/validation.js";
import { DEFAULT_DOWNLOAD_DIR, validateSavePath } from "../security/save-path.js";

registerTool(
  {
    name: "download_attachment",
    description: "Download an email attachment to a safe directory",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID" },
        attachment_id: { type: "string", description: "Attachment ID from read_email" },
        save_to: { type: "string", description: `Directory to save to (default ~/Downloads/mailbox-mcp). Allowed: ~/Downloads/mailbox-mcp or /tmp.` },
      },
      required: ["account", "message_id", "attachment_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const result = await provider.downloadAttachment(args.message_id as string, args.attachment_id as string);

    validateAttachmentPath(result.filename);

    const dir = (args.save_to as string) ?? DEFAULT_DOWNLOAD_DIR;
    validateSavePath(dir);

    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }

    const filePath = join(dir, result.filename);
    writeFileSync(filePath, result.data, { mode: 0o600 });
    chmodSync(filePath, 0o600);

    return { content: [{ type: "text", text: `Downloaded "${result.filename}" (${result.mimeType}, ${result.data.length} bytes) to ${filePath}` }] };
  }
);
