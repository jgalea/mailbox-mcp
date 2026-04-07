import { registerTool } from "./registry.js";

registerTool(
  { name: "list_labels", description: "List all labels (Gmail) or folders (IMAP) for an account",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const labels = await provider.listLabels();
    const lines = labels.map((l) => `- **${l.name}** (${l.type}) [${l.id}]`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

registerTool(
  { name: "create_label", description: "Create a new label (Gmail) or folder (IMAP)",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, name: { type: "string", description: "Label/folder name" } }, required: ["account", "name"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const label = await provider.createLabel(args.name as string);
    return { content: [{ type: "text", text: `Created label "${label.name}" (${label.id})` }] };
  }
);

registerTool(
  { name: "delete_label", description: "Delete a label (Gmail) or folder (IMAP)",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, label_id: { type: "string", description: "Label/folder ID to delete" } }, required: ["account", "label_id"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.deleteLabel(args.label_id as string);
    return { content: [{ type: "text", text: `Label "${args.label_id}" deleted.` }] };
  }
);

registerTool(
  { name: "modify_email", description: "Add or remove labels/flags on a message",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" }, message_id: { type: "string", description: "Message ID" },
      add_labels: { type: "array", items: { type: "string" }, description: "Labels to add" },
      remove_labels: { type: "array", items: { type: "string" }, description: "Labels to remove" },
    }, required: ["account", "message_id"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.modifyLabels(args.message_id as string, (args.add_labels as string[]) ?? [], (args.remove_labels as string[]) ?? []);
    return { content: [{ type: "text", text: `Message "${args.message_id}" updated.` }] };
  }
);

registerTool(
  { name: "batch_modify_emails", description: "Add or remove labels/flags on multiple messages",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" },
      message_ids: { type: "array", items: { type: "string" }, description: "Message IDs" },
      add_labels: { type: "array", items: { type: "string" }, description: "Labels to add" },
      remove_labels: { type: "array", items: { type: "string" }, description: "Labels to remove" },
    }, required: ["account", "message_ids"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.batchModifyLabels(args.message_ids as string[], (args.add_labels as string[]) ?? [], (args.remove_labels as string[]) ?? []);
    return { content: [{ type: "text", text: `${(args.message_ids as string[]).length} messages updated.` }] };
  }
);

registerTool(
  { name: "trash_emails", description: "Move messages to trash",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" },
      message_ids: { type: "array", items: { type: "string" }, description: "Message IDs to trash" },
    }, required: ["account", "message_ids"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.trashMessages(args.message_ids as string[]);
    return { content: [{ type: "text", text: `${(args.message_ids as string[]).length} messages trashed.` }] };
  }
);
