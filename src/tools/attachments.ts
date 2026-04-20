import { join, resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { registerTool } from "./registry.js";
import { validateAttachmentPath } from "../security/validation.js";

const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads", "mailbox-mcp");

const ALLOWED_BASE_DIRS = [
  DEFAULT_DOWNLOAD_DIR,
  "/tmp",
];

/**
 * Resolve a path's canonical form, walking up to the deepest existing
 * ancestor so symlinks like macOS's `/tmp -> /private/tmp` are followed even
 * when the target path itself has not been created yet.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
  const realBase = realpathSync(probe);
  return probe === absolute ? realBase : join(realBase, absolute.slice(probe.length));
}

function validateSavePath(dir: string): void {
  const resolved = canonicalize(dir);
  const isAllowed = ALLOWED_BASE_DIRS.some((base) => {
    const resolvedBase = canonicalize(base);
    return resolved === resolvedBase || resolved.startsWith(resolvedBase + "/");
  });
  if (!isAllowed) {
    throw new Error(
      `Save directory "${dir}" is not allowed. ` +
      `Permitted locations: ${ALLOWED_BASE_DIRS.join(", ")}`
    );
  }
}

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
