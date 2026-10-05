import { registerTool, lookupAccount, sanitizeErrorMessage } from "./registry.js";
import { redactTokens } from "../security/sanitize.js";
import { noteSenders } from "../security/taint.js";
import { gateOutgoing, isRefusal, queueOutgoing } from "./write.js";
import { recordSend } from "../sendlog.js";

registerTool(
  {
    name: "mark_read",
    description: "Mark an email as read or unread",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID" },
        read: { type: "boolean", description: "true to mark read, false to mark unread (default true)" },
      },
      required: ["account", "message_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const read = (args.read as boolean | undefined) ?? true;
    await provider.markRead(args.message_id as string, read);
    return { content: [{ type: "text", text: `Message ${args.message_id} marked as ${read ? "read" : "unread"}.` }] };
  }
);

registerTool(
  {
    name: "star_email",
    description: "Star or unstar an email",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID" },
        starred: { type: "boolean", description: "true to star, false to unstar (default true)" },
      },
      required: ["account", "message_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const starred = (args.starred as boolean | undefined) ?? true;
    await provider.starMessage(args.message_id as string, starred);
    return { content: [{ type: "text", text: `Message ${args.message_id} ${starred ? "starred" : "unstarred"}.` }] };
  }
);

registerTool(
  {
    name: "archive_email",
    description: "Archive an email (remove from inbox). Gmail removes the INBOX label; IMAP moves to the Archive folder; JMAP moves out of the inbox mailbox.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID" },
      },
      required: ["account", "message_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.archiveMessage(args.message_id as string);
    return { content: [{ type: "text", text: `Message ${args.message_id} archived.` }] };
  }
);

registerTool(
  {
    name: "list_drafts",
    description: "List drafts for an account",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        max_results: { type: "number", description: "Max drafts to return (default 20)" },
      },
      required: ["account"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const drafts = await provider.listDrafts((args.max_results as number) ?? 20);
    if (drafts.length === 0) return { content: [{ type: "text", text: "No drafts." }] };
    const lines = drafts.map((d) =>
      `- **${d.id}** | ${ctx.fence.header(d.to.join(", "), "to")} | ${ctx.fence.content(d.subject, "subject")} (${d.updatedAt})`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

registerTool(
  {
    name: "send_draft",
    description: "Send an existing draft as-is. Runs the same recipient guards as send_email. For Gmail/JMAP the draft is finalised and submitted; for IMAP the message is sent via SMTP and removed from the Drafts folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        draft_id: { type: "string", description: "Draft ID from list_drafts or create_draft" },
        confirm_new_recipient: { type: "boolean", description: "Required (true) when the draft goes to an address this account has never sent to or received from. Only set it when the user explicitly asked." },
      },
      required: ["account", "draft_id"],
    },
  },
  async (args, ctx) => {
    const account = args.account as string;
    const draftId = args.draft_id as string;
    const provider = await ctx.getProvider(account);
    if (!provider.getDraftRecipients) {
      return { content: [{ type: "text", text: "Refused: this provider cannot report the draft's recipients, so the send guards cannot run." }], isError: true };
    }
    const recipients = await provider.getDraftRecipients(draftId);
    const gate = await gateOutgoing(args, ctx, { account, recipients });
    if (isRefusal(gate)) return gate;
    if (gate.draftsOnly) {
      return { content: [{ type: "text", text: `Refused: account "${account}" is configured draftsOnly. The draft stays in Drafts for the user to send from their mail client.` }], isError: true };
    }
    if (gate.queueReason) {
      if (!provider.draftFingerprint) {
        return { content: [{ type: "text", text: "Refused: this provider cannot fingerprint the draft, so a queued send could not be tied to what the user reviews. Use send_email with the draft's content instead." }], isError: true };
      }
      const fingerprint = await provider.draftFingerprint(draftId);
      return queueOutgoing(gate, {
        account, tool: "send_draft", action: { kind: "sendDraft", draftId, fingerprint },
        to: recipients, cc: [], bcc: [], subject: "", body: "", attachments: [],
      });
    }
    const id = await provider.sendDraft(draftId);
    recordSend(account, "send_draft", recipients);
    return { content: [{ type: "text", text: `Draft sent. Message ID: ${id}` }] };
  }
);

registerTool(
  {
    name: "count_unread_by_label",
    description: "Count unread messages per label/folder. Useful for deciding where to look first.",
    inputSchema: {
      type: "object" as const,
      properties: { account: { type: "string", description: "Account alias" } },
      required: ["account"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const counts = await provider.countUnreadByLabel();
    if (counts.length === 0) return { content: [{ type: "text", text: "No unread messages in any label." }] };
    const lines = counts.map((c) => `- **${c.name}**: ${c.unread} unread`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

registerTool(
  {
    name: "emails_since",
    description: "List messages received after a given timestamp. Use for polling new mail since a last-check marker.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        since: { type: "string", description: "ISO 8601 timestamp, e.g. '2026-04-20T10:00:00Z'" },
        folder: { type: "string", description: "Optional folder/label to scope the search" },
        max_results: { type: "number", description: "Max results (default 50)" },
      },
      required: ["account", "since"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const results = await provider.messagesSince(
      args.since as string,
      args.folder as string | undefined,
      (args.max_results as number) ?? 50,
    );
    if (results.length === 0) return { content: [{ type: "text", text: "No messages since that timestamp." }] };
    const lines = results.map((m) =>
      `- **${m.id}** | ${ctx.fence.sender(m)} | ${ctx.fence.content(m.subject, "subject")} (${m.date})`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

registerTool(
  {
    name: "multi_account_search",
    description: "Run the same search across all configured accounts in parallel. Returns results grouped by account alias.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (Gmail syntax for Gmail accounts; plain text for IMAP/JMAP)" },
        max_results: { type: "number", description: "Max results per account (default 10)" },
      },
      required: ["query"],
    },
  },
  async (args, ctx) => {
    const accounts = Object.keys(ctx.accountManager.listAccounts());
    if (accounts.length === 0) return { content: [{ type: "text", text: "No accounts configured." }] };
    const max = (args.max_results as number) ?? 10;
    const query = args.query as string;
    const settled = await Promise.allSettled(
      accounts.map(async (alias) => {
        const provider = await ctx.getProvider(alias);
        const results = await provider.searchMessages(query, max);
        return { alias, results };
      })
    );

    const sections: string[] = [];
    for (const [i, outcome] of settled.entries()) {
      const alias = accounts[i];
      if (outcome.status === "rejected") {
        const raw = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        sections.push(`## ${alias}\n\nError: ${sanitizeErrorMessage(raw, redactTokens)}`);
        continue;
      }
      const { results } = outcome.value;
      if (results.length === 0) {
        sections.push(`## ${alias}\n\n(no results)`);
        continue;
      }
      noteSenders(alias, lookupAccount(ctx, alias), "multi_account_search", results.map((m) => ({ from: m.from, auth: m.auth })));
      const lines = results.map((m) =>
        `- **${m.id}** | ${ctx.fence.sender(m)} | ${ctx.fence.content(m.subject, "subject")} (${m.date})`
      );
      sections.push(`## ${alias}\n\n${lines.join("\n")}`);
    }
    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  }
);
