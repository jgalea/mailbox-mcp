import { registerTool } from "./registry.js";

const sendCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_SENDS_PER_MINUTE = 10;

export function checkSendLimit(account: string): string | null {
  const now = Date.now();
  const entry = sendCounts.get(account);
  if (!entry || now > entry.resetAt) {
    sendCounts.set(account, { count: 1, resetAt: now + 60_000 });
    return null;
  }
  if (entry.count >= MAX_SENDS_PER_MINUTE) {
    return `Rate limit: maximum ${MAX_SENDS_PER_MINUTE} emails per minute per account. Try again in ${Math.ceil((entry.resetAt - now) / 1000)}s.`;
  }
  entry.count++;
  return null;
}

registerTool(
  {
    name: "send_email",
    description: "Send a new email",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body" },
        cc: { type: "array", items: { type: "string" }, description: "CC recipients" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC recipients" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  async (args, ctx) => {
    const rateLimitError = checkSendLimit(args.account as string);
    if (rateLimitError) return { content: [{ type: "text", text: rateLimitError }], isError: true };
    const provider = await ctx.getProvider(args.account as string);
    const id = await provider.sendMessage(args.to as string[], args.subject as string, args.body as string, {
      cc: args.cc as string[] | undefined, bcc: args.bcc as string[] | undefined, html: args.html as boolean | undefined,
    });
    return { content: [{ type: "text", text: `Email sent. Message ID: ${id}` }] };
  }
);

registerTool(
  {
    name: "reply_email",
    description: "Reply to an email message",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID to reply to" },
        body: { type: "string", description: "Reply body" },
        reply_all: { type: "boolean", description: "Reply to all recipients (default false)" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
      },
      required: ["account", "message_id", "body"],
    },
  },
  async (args, ctx) => {
    const rateLimitError = checkSendLimit(args.account as string);
    if (rateLimitError) return { content: [{ type: "text", text: rateLimitError }], isError: true };
    const provider = await ctx.getProvider(args.account as string);
    const id = await provider.replyToMessage(args.message_id as string, args.body as string, {
      replyAll: args.reply_all as boolean | undefined, html: args.html as boolean | undefined,
    });
    return { content: [{ type: "text", text: `Reply sent. Message ID: ${id}` }] };
  }
);

registerTool(
  {
    name: "forward_email",
    description: "Forward an email message to new recipients",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID to forward" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        message: { type: "string", description: "Optional message to add above the forwarded content" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
      },
      required: ["account", "message_id", "to"],
    },
  },
  async (args, ctx) => {
    const rateLimitError = checkSendLimit(args.account as string);
    if (rateLimitError) return { content: [{ type: "text", text: rateLimitError }], isError: true };
    const provider = await ctx.getProvider(args.account as string);
    const id = await provider.forwardMessage(args.message_id as string, args.to as string[], {
      message: args.message as string | undefined, html: args.html as boolean | undefined,
    });
    return { content: [{ type: "text", text: `Forwarded. Message ID: ${id}` }] };
  }
);

registerTool(
  {
    name: "create_draft",
    description: "Create a draft email",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body" },
        cc: { type: "array", items: { type: "string" }, description: "CC recipients" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC recipients" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
        in_reply_to: { type: "string", description: "Message ID to create draft as reply to" },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const id = await provider.createDraft(args.to as string[], args.subject as string, args.body as string, {
      cc: args.cc as string[] | undefined, bcc: args.bcc as string[] | undefined,
      html: args.html as boolean | undefined, inReplyTo: args.in_reply_to as string | undefined,
    });
    return { content: [{ type: "text", text: `Draft created. Draft ID: ${id}` }] };
  }
);
