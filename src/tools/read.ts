import { registerTool } from "./registry.js";
import { fenceEmailContent, fenceEmailHeader } from "../security/sanitize.js";

registerTool(
  {
    name: "search_emails",
    description: "Search emails in an account. Gmail supports full Gmail search syntax. IMAP searches subject and body.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (default 20)" },
      },
      required: ["account", "query"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const results = await provider.searchMessages(args.query as string, (args.max_results as number) ?? 20);
    if (results.length === 0) return { content: [{ type: "text", text: "No messages found." }] };
    const lines = results.map((m) => `**${m.id}** | ${fenceEmailHeader(m.from, "from")} | ${fenceEmailContent(m.subject, "subject")}\n  ${fenceEmailContent(m.snippet)} (${m.date})`);
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
    const text = [
      `**From:** ${fenceEmailHeader(msg.from, "from")}`, `**To:** ${fenceEmailHeader(msg.to.join(", "), "to")}`,
      msg.cc.length ? `**Cc:** ${fenceEmailHeader(msg.cc.join(", "), "cc")}` : "",
      `**Subject:** ${fenceEmailContent(msg.subject, "subject")}`, `**Date:** ${msg.date}`,
      msg.attachments.length ? `**Attachments:** ${msg.attachments.map((a) => `${fenceEmailHeader(a.filename, "filename")} (${a.id})`).join(", ")}` : "",
      "", fenceEmailContent(msg.body),
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

registerTool(
  {
    name: "read_thread",
    description: "Read an entire email conversation thread",
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
    const text = [
      `**Thread:** ${thread.id} — ${fenceEmailContent(thread.subject, "subject")}`, `**Messages:** ${thread.messages.length}`, "",
      ...thread.messages.map((m, i) => `--- Message ${i + 1} ---\n**From:** ${fenceEmailHeader(m.from, "from")}\n**Date:** ${m.date}\n\n${fenceEmailContent(m.body)}`),
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
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
    const recentLines = summary.recent.map((m) => `- ${fenceEmailHeader(m.from, "from")}: ${fenceEmailContent(m.subject, "subject")} (${m.date})`);
    const text = [`**Total:** ${summary.total}`, `**Unread:** ${summary.unread}`, "", "**Recent:**", ...recentLines].join("\n");
    return { content: [{ type: "text", text }] };
  }
);
