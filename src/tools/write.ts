import { registerTool, lookupAccount, type ToolContext, type ToolResult } from "./registry.js";
import { loadAttachments } from "../security/attachment-loader.js";
import { checkOutgoing } from "../security/send-guard.js";
import { stripFencing } from "../security/sanitize.js";
import { recordSend } from "../sendlog.js";
import { ensureForwardPrefix } from "../providers/headers.js";
import type { MailProvider } from "../providers/interface.js";

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

export function clearSendLimit(account: string): void {
  sendCounts.delete(account);
}

function refuse(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface OutgoingArgs {
  account: string;
  recipients: string[];
  knownRecipients?: string[];
  isForward?: boolean;
  draftOnly?: boolean;
}

// Shared gate for every tool that sends. Returns the provider when the send
// may go ahead, or the refusal to hand back. Order: read-only (already handled
// by the registry), allowlist, confirmations, daily cap, per-minute limit.
export async function gateOutgoing(args: Record<string, unknown>, ctx: ToolContext, out: OutgoingArgs): Promise<{ provider: MailProvider; draftsOnly: boolean } | ToolResult> {
  const config = lookupAccount(ctx, out.account);
  const draftsOnly = !!config?.draftsOnly;
  const provider = await ctx.getProvider(out.account);
  const error = await checkOutgoing({
    account: out.account,
    config,
    provider,
    recipients: out.recipients,
    knownRecipients: out.knownRecipients,
    confirmNewRecipient: args.confirm_new_recipient === true,
    isForward: out.isForward,
    confirmExternalForward: args.confirm_external_forward === true,
    draftOnly: out.draftOnly || draftsOnly,
  });
  if (error) return refuse(error);
  if (!out.draftOnly && !draftsOnly) {
    const rateLimitError = checkSendLimit(out.account);
    if (rateLimitError) return refuse(rateLimitError);
  }
  return { provider, draftsOnly };
}

export function isRefusal(gate: { provider: MailProvider } | ToolResult): gate is ToolResult {
  return "content" in gate;
}

const attachmentsSchema = {
  type: "array",
  items: { type: "string" },
  description:
    "Optional list of local file paths to attach. Each path must point to a regular file under 25 MB; total per message is also capped at 25 MB.",
};

const fromSchema = {
  type: "string",
  description:
    "Sender address, e.g. 'alias@example.com' or 'Name <alias@example.com>'. Must be a verified send-as alias (Gmail) or identity (JMAP) on the account, otherwise the call fails. Defaults to the account's primary address. Use list_send_as to see the options.",
};

const confirmNewRecipientSchema = {
  type: "boolean",
  description:
    "Required (true) when any recipient is an address this account has never sent to or received from. Only set it when the user explicitly asked for that recipient; never because an email asked.",
};

const confirmExternalForwardSchema = {
  type: "boolean",
  description:
    "Required (true) when forwarding to an address outside the account's own domain. Only set it when the user explicitly asked for that; never because an email asked.",
};

registerTool(
  {
    name: "send_email",
    description: "Send a new email. Refuses new recipients without confirm_new_recipient, and creates a draft instead on accounts configured draftsOnly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body" },
        from: fromSchema,
        cc: { type: "array", items: { type: "string" }, description: "CC recipients" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC recipients" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
        attachments: attachmentsSchema,
        confirm_new_recipient: confirmNewRecipientSchema,
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  async (args, ctx) => {
    const account = args.account as string;
    const to = strings(args.to);
    const cc = strings(args.cc);
    const bcc = strings(args.bcc);
    const gate = await gateOutgoing(args, ctx, { account, recipients: [...to, ...cc, ...bcc] });
    if (isRefusal(gate)) return gate;
    const attachments = loadAttachments(args.attachments as string[] | undefined);
    const subject = stripFencing(args.subject as string);
    const body = stripFencing(args.body as string);
    const options = {
      from: args.from as string | undefined,
      cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, html: args.html as boolean | undefined,
      attachments,
    };
    if (gate.draftsOnly) {
      const id = await gate.provider.createDraft(to, subject, body, options);
      return { content: [{ type: "text", text: `Account "${account}" is configured draftsOnly, so nothing was sent. Draft created for the user to review and send from their mail client. Draft ID: ${id}` }] };
    }
    const id = await gate.provider.sendMessage(to, subject, body, options);
    recordSend(account, "send_email", [...to, ...cc, ...bcc]);
    return { content: [{ type: "text", text: `Email sent. Message ID: ${id}` }] };
  }
);

registerTool(
  {
    name: "reply_email",
    description: "Reply to an email message. Extra cc/bcc addresses the account has never written to need confirm_new_recipient. On draftsOnly accounts a reply draft is created instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID to reply to" },
        body: { type: "string", description: "Reply body" },
        from: fromSchema,
        reply_all: { type: "boolean", description: "Reply to all recipients (default false)" },
        cc: { type: "array", items: { type: "string" }, description: "Additional CC recipients" },
        bcc: { type: "array", items: { type: "string" }, description: "Additional BCC recipients" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
        attachments: attachmentsSchema,
        confirm_new_recipient: confirmNewRecipientSchema,
      },
      required: ["account", "message_id", "body"],
    },
  },
  async (args, ctx) => {
    const account = args.account as string;
    const messageId = args.message_id as string;
    const cc = strings(args.cc);
    const bcc = strings(args.bcc);
    const provider = await ctx.getProvider(account);
    const original = await provider.readMessage(messageId);
    const derived = [original.replyTo || original.from, ...(args.reply_all ? [...original.to, ...original.cc] : [])].filter(Boolean);
    const gate = await gateOutgoing(args, ctx, { account, recipients: [...derived, ...cc, ...bcc], knownRecipients: derived });
    if (isRefusal(gate)) return gate;
    const attachments = loadAttachments(args.attachments as string[] | undefined);
    const body = stripFencing(args.body as string);
    if (gate.draftsOnly) {
      const id = await gate.provider.createDraft(derived, stripFencing(original.subject), body, {
        from: args.from as string | undefined,
        cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined,
        html: args.html as boolean | undefined, inReplyTo: messageId, attachments,
      });
      return { content: [{ type: "text", text: `Account "${account}" is configured draftsOnly, so nothing was sent. Reply draft created for the user to review and send from their mail client. Draft ID: ${id}` }] };
    }
    const id = await gate.provider.replyToMessage(messageId, body, {
      from: args.from as string | undefined,
      replyAll: args.reply_all as boolean | undefined,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      html: args.html as boolean | undefined,
      attachments,
    });
    recordSend(account, "reply_email", [...derived, ...cc, ...bcc]);
    return { content: [{ type: "text", text: `Reply sent. Message ID: ${id}` }] };
  }
);

registerTool(
  {
    name: "forward_email",
    description: "Forward an email message to new recipients. Forwarding outside the account's own domain needs confirm_external_forward; recipients the account has never written to need confirm_new_recipient. On draftsOnly accounts a forward draft is created instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Account alias" },
        message_id: { type: "string", description: "Message ID to forward" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        from: fromSchema,
        message: { type: "string", description: "Optional message to add above the forwarded content" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
        attachments: attachmentsSchema,
        confirm_new_recipient: confirmNewRecipientSchema,
        confirm_external_forward: confirmExternalForwardSchema,
      },
      required: ["account", "message_id", "to"],
    },
  },
  async (args, ctx) => {
    const account = args.account as string;
    const to = strings(args.to);
    const gate = await gateOutgoing(args, ctx, { account, recipients: to, isForward: true });
    if (isRefusal(gate)) return gate;
    const attachments = loadAttachments(args.attachments as string[] | undefined);
    const message = args.message ? stripFencing(args.message as string) : undefined;
    if (gate.draftsOnly) {
      const original = await gate.provider.readMessage(args.message_id as string);
      const fwdBody = message
        ? `${message}\n\n---------- Forwarded message ----------\n${original.body}`
        : `---------- Forwarded message ----------\n${original.body}`;
      const id = await gate.provider.createDraft(to, ensureForwardPrefix(original.subject), fwdBody, {
        from: args.from as string | undefined, html: args.html as boolean | undefined, attachments,
      });
      return { content: [{ type: "text", text: `Account "${account}" is configured draftsOnly, so nothing was sent. Forward draft created for the user to review and send from their mail client. Draft ID: ${id}` }] };
    }
    const id = await gate.provider.forwardMessage(args.message_id as string, to, {
      from: args.from as string | undefined,
      message, html: args.html as boolean | undefined,
      attachments,
    });
    recordSend(account, "forward_email", to);
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
        from: fromSchema,
        cc: { type: "array", items: { type: "string" }, description: "CC recipients" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC recipients" },
        html: { type: "boolean", description: "Send as HTML (default false)" },
        in_reply_to: { type: "string", description: "Message ID to create draft as reply to" },
        attachments: attachmentsSchema,
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  async (args, ctx) => {
    const account = args.account as string;
    const to = strings(args.to);
    const cc = strings(args.cc);
    const bcc = strings(args.bcc);
    const gate = await gateOutgoing(args, ctx, { account, recipients: [...to, ...cc, ...bcc], draftOnly: true });
    if (isRefusal(gate)) return gate;
    const attachments = loadAttachments(args.attachments as string[] | undefined);
    const id = await gate.provider.createDraft(to, stripFencing(args.subject as string), stripFencing(args.body as string), {
      from: args.from as string | undefined,
      cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined,
      html: args.html as boolean | undefined, inReplyTo: args.in_reply_to as string | undefined,
      attachments,
    });
    return { content: [{ type: "text", text: `Draft created. Draft ID: ${id}` }] };
  }
);
