import { registerTool } from "./registry.js";
import { recordTransaction, listTransactions, findTransaction, markReversed } from "../transactions.js";

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

registerTool(
  { name: "bulk_trash", description: "Trash all messages matching a query. Paginates the search and batch-trashes the IDs in one call. Use dry_run to see the count before committing. Useful for label cleanups (e.g. trash everything in 'Newsletters' or older than 90 days).",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" },
      query: { type: "string", description: "Search query (Gmail syntax for Gmail accounts, e.g. 'label:Meetups' or 'from:noreply@example.com older_than:30d')" },
      folder: { type: "string", description: "Optional folder/label scope. On Gmail this becomes a 'label:' prefix; on IMAP/JMAP it scopes the search to that mailbox." },
      dry_run: { type: "boolean", description: "If true, return the matching count without trashing anything." },
      max: { type: "number", description: "Safety cap on number of messages to trash. Defaults to no cap; set this to bound destructive scope." },
    }, required: ["account", "query"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const ids = await provider.findMessageIds(
      args.query as string,
      args.folder as string | undefined,
      args.max as number | undefined,
    );
    if (args.dry_run) {
      return { content: [{ type: "text", text: `${ids.length} messages match (dry run, nothing trashed).` }] };
    }
    if (ids.length === 0) {
      return { content: [{ type: "text", text: "No messages matched the query." }] };
    }
    await provider.trashMessages(ids);
    const tx = recordTransaction({
      account: args.account as string,
      tool: "bulk_trash",
      query: args.query as string,
      folder: args.folder as string | undefined,
      add_labels: ["TRASH"],
      remove_labels: [],
      message_ids: ids,
    });
    return { content: [{ type: "text", text: `${ids.length} messages trashed. Reversible via undo_bulk_op id=${tx.id}` }] };
  }
);

registerTool(
  { name: "bulk_modify", description: "Add or remove labels on all messages matching a query. Same fast search-then-batch pattern as bulk_trash, but for arbitrary label ops. Use this for archive (remove_labels=['INBOX']), bulk star/unstar, mark-read across a label, moving messages between labels, etc. Use dry_run to see the count first.",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" },
      query: { type: "string", description: "Search query (Gmail syntax for Gmail accounts, e.g. 'in:inbox older_than:30d')" },
      folder: { type: "string", description: "Optional folder/label scope. On Gmail becomes a 'label:' prefix; on IMAP/JMAP scopes the search to that mailbox." },
      add_labels: { type: "array", items: { type: "string" }, description: "Labels to add to each matching message." },
      remove_labels: { type: "array", items: { type: "string" }, description: "Labels to remove from each matching message. Use ['INBOX'] for archive." },
      dry_run: { type: "boolean", description: "If true, return the matching count without modifying anything." },
      max: { type: "number", description: "Safety cap on number of messages to modify. Defaults to no cap." },
    }, required: ["account", "query"] } },
  async (args, ctx) => {
    const add = (args.add_labels as string[]) ?? [];
    const remove = (args.remove_labels as string[]) ?? [];
    if (add.length === 0 && remove.length === 0) {
      return { content: [{ type: "text", text: "Nothing to do — supply add_labels and/or remove_labels." }], isError: true };
    }
    const provider = await ctx.getProvider(args.account as string);
    const ids = await provider.findMessageIds(
      args.query as string,
      args.folder as string | undefined,
      args.max as number | undefined,
    );
    if (args.dry_run) {
      return { content: [{ type: "text", text: `${ids.length} messages match (dry run, nothing modified).` }] };
    }
    if (ids.length === 0) {
      return { content: [{ type: "text", text: "No messages matched the query." }] };
    }
    await provider.batchModifyLabels(ids, add, remove);
    const tx = recordTransaction({
      account: args.account as string,
      tool: "bulk_modify",
      query: args.query as string,
      folder: args.folder as string | undefined,
      add_labels: add,
      remove_labels: remove,
      message_ids: ids,
    });
    const summary = [add.length ? `added [${add.join(", ")}]` : null, remove.length ? `removed [${remove.join(", ")}]` : null].filter(Boolean).join(" and ");
    return { content: [{ type: "text", text: `${ids.length} messages updated — ${summary}. Reversible via undo_bulk_op id=${tx.id}` }] };
  }
);

registerTool(
  { name: "list_recent_bulk_ops", description: "List recent bulk_modify and bulk_trash operations recorded in the transaction log. Use to find an op id for undo_bulk_op.",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Optional account filter." },
      limit: { type: "number", description: "Max records to return (default 20)." },
    }, required: [] } },
  async (args) => {
    const txs = listTransactions({ account: args.account as string | undefined, limit: (args.limit as number | undefined) ?? 20 });
    if (txs.length === 0) return { content: [{ type: "text", text: "No bulk operations recorded yet." }] };
    const lines = txs.map((t) => {
      const reversed = t.reversed_at ? ` [REVERSED ${t.reversed_at} via ${t.reversed_by}]` : "";
      const labels = [t.add_labels.length ? `+[${t.add_labels.join(",")}]` : null, t.remove_labels.length ? `-[${t.remove_labels.join(",")}]` : null].filter(Boolean).join(" ");
      return `- ${t.id} ${t.ts} ${t.account} ${t.tool} count=${t.message_ids.length} ${labels} query="${t.query}"${reversed}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

registerTool(
  { name: "undo_bulk_op", description: "Reverse a previously recorded bulk_modify or bulk_trash by replaying the inverse label change against the exact ids that were touched. Find the op id from list_recent_bulk_ops. Idempotent on already-reversed ops (refuses to re-reverse).",
    inputSchema: { type: "object" as const, properties: {
      op_id: { type: "string", description: "The op id from list_recent_bulk_ops." },
    }, required: ["op_id"] } },
  async (args, ctx) => {
    const tx = findTransaction(args.op_id as string);
    if (!tx) return { content: [{ type: "text", text: `Op id "${args.op_id}" not found.` }], isError: true };
    if (tx.reversed_at) return { content: [{ type: "text", text: `Op ${tx.id} was already reversed at ${tx.reversed_at}.` }], isError: true };
    const provider = await ctx.getProvider(tx.account);
    // Inverse: swap add and remove. bulk_trash recorded add=["TRASH"]; undo removes TRASH.
    await provider.batchModifyLabels(tx.message_ids, tx.remove_labels, tx.add_labels);
    markReversed(tx.id, "undo_bulk_op");
    const inverse = [tx.add_labels.length ? `removed [${tx.add_labels.join(", ")}]` : null, tx.remove_labels.length ? `added [${tx.remove_labels.join(", ")}]` : null].filter(Boolean).join(" and ");
    return { content: [{ type: "text", text: `Reversed op ${tx.id}: ${tx.message_ids.length} messages — ${inverse}.` }] };
  }
);
