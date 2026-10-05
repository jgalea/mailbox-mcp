import { registerTool } from "./registry.js";

registerTool(
  {
    name: "search_emails",
    description: "Search emails in an account. Gmail supports full Gmail search syntax. IMAP searches subject and body. Optional folder parameter scopes the search to a specific label/folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (default 20)" },
        folder: { type: "string", description: "Optional folder/label to scope the search (IMAP mailbox path, Gmail label name, or JMAP mailbox name/id)" },
      },
      required: ["account", "query"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const results = await provider.searchMessages(
      args.query as string,
      (args.max_results as number) ?? 20,
      args.folder as string | undefined,
    );
    if (results.length === 0) return { content: [{ type: "text", text: "No messages found." }] };
    const f = ctx.fence;
    const lines = results.map((m) => `**${m.id}** | ${f.header(m.from, "from")} | ${f.content(m.subject, "subject")}\n  ${f.content(m.snippet)} (${f.header(m.date, "date")})`);
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

registerTool(
  {
    name: "read_email",
    description: "Read a single email message with full content",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID from search results" },
      },
      required: ["account", "message_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const msg = await provider.readMessage(args.message_id as string);
    const f = ctx.fence;
    const text = [
      `**From:** ${f.header(msg.from, "from")}`, `**To:** ${f.header(msg.to.join(", "), "to")}`,
      msg.cc.length ? `**Cc:** ${f.header(msg.cc.join(", "), "cc")}` : "",
      `**Subject:** ${f.content(msg.subject, "subject")}`, `**Date:** ${f.header(msg.date, "date")}`,
      msg.attachments.length ? `**Attachments:** ${msg.attachments.map((a) => `${f.header(a.filename, "filename")} (${a.id})`).join(", ")}` : "",
      "", f.body(msg.body, msg.bodyIsHtml),
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

registerTool(
  {
    name: "read_thread",
    description: "Read an entire email conversation thread (Gmail and JMAP only)",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        thread_id: { type: "string", description: "Thread ID" },
      },
      required: ["account", "thread_id"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const thread = await provider.readThread(args.thread_id as string);
    const f = ctx.fence;
    const text = [
      `**Thread:** ${thread.id} — ${f.content(thread.subject, "subject")}`, `**Messages:** ${thread.messages.length}`, "",
      ...thread.messages.map((m, i) => `--- Message ${i + 1} ---\n**From:** ${f.header(m.from, "from")}\n**Date:** ${f.header(m.date, "date")}\n\n${f.body(m.body, m.bodyIsHtml)}`),
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
  "threads"
);

registerTool(
  {
    name: "inbox_summary",
    description: "Get a summary of recent inbox activity including total and unread counts",
    inputSchema: {
      type: "object" as const,
      properties: { account: { type: "string", description: "Account alias" } },
      required: ["account"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const summary = await provider.inboxSummary();
    const f = ctx.fence;
    const recentLines = summary.recent.map((m) => `- ${f.header(m.from, "from")}: ${f.content(m.subject, "subject")} (${f.header(m.date, "date")})`);
    const text = [`**Total:** ${summary.total}`, `**Unread:** ${summary.unread}`, "", "**Recent:**", ...recentLines].join("\n");
    return { content: [{ type: "text", text }] };
  }
);
