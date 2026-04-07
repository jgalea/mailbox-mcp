import { registerTool } from "./registry.js";
import { fenceEmailHeader, fenceEmailContent, stripFencing } from "../security/sanitize.js";
import { checkSendLimit } from "./write.js";

function getGmailApi(provider: any) {
  if (provider.type !== "gmail" || !provider.gmailApi) {
    throw new Error("This tool requires a Gmail account");
  }
  return provider.gmailApi;
}

// --- Filters ---
registerTool(
  { name: "list_filters", description: "List Gmail filters",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const res = await gmail.users.settings.filters.list({ userId: "me" });
    const filters = res.data.filter ?? [];
    if (filters.length === 0) return { content: [{ type: "text", text: "No filters configured." }] };
    const lines = filters.map((f: any) => `- **${f.id}**: ${fenceEmailContent(JSON.stringify(f.criteria))} → ${fenceEmailContent(JSON.stringify(f.action))}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }, "filters"
);

registerTool(
  { name: "create_filter", description: "Create a Gmail filter",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" },
      from: { type: "string", description: "Filter by sender" }, to: { type: "string", description: "Filter by recipient" },
      subject: { type: "string", description: "Filter by subject" }, query: { type: "string", description: "Filter by search query" },
      add_label: { type: "string", description: "Label to apply" }, remove_label: { type: "string", description: "Label to remove" },
      archive: { type: "boolean", description: "Skip inbox" }, mark_read: { type: "boolean", description: "Mark as read" },
    }, required: ["account"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const criteria: Record<string, string> = {};
    if (args.from) criteria.from = args.from as string;
    if (args.to) criteria.to = args.to as string;
    if (args.subject) criteria.subject = args.subject as string;
    if (args.query) criteria.query = args.query as string;
    const action: Record<string, any> = {};
    if (args.add_label) action.addLabelIds = [args.add_label as string];
    if (args.remove_label) action.removeLabelIds = [args.remove_label as string];
    if (args.archive) action.removeLabelIds = [...(action.removeLabelIds ?? []), "INBOX"];
    if (args.mark_read) action.removeLabelIds = [...(action.removeLabelIds ?? []), "UNREAD"];
    const allowedActionKeys = new Set(["addLabelIds", "removeLabelIds"]);
    const disallowed = Object.keys(action).filter(k => !allowedActionKeys.has(k));
    if (disallowed.length > 0) {
      return {
        content: [{ type: "text", text: `Filter actions [${disallowed.join(", ")}] are blocked for security. Only label changes are allowed.` }],
        isError: true,
      };
    }
    const res = await gmail.users.settings.filters.create({ userId: "me", requestBody: { criteria, action } });
    return { content: [{ type: "text", text: `Filter created: ${res.data.id}` }] };
  }, "filters"
);

registerTool(
  { name: "delete_filter", description: "Delete a Gmail filter",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, filter_id: { type: "string", description: "Filter ID to delete" } }, required: ["account", "filter_id"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    await gmail.users.settings.filters.delete({ userId: "me", id: args.filter_id as string });
    return { content: [{ type: "text", text: `Filter "${args.filter_id}" deleted.` }] };
  }, "filters"
);

// --- Snooze ---
registerTool(
  { name: "snooze_email", description: "Snooze an email until a specified time by removing from inbox and scheduling return",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" }, message_id: { type: "string", description: "Message ID" },
      until: { type: "string", description: "ISO 8601 datetime to unsnooze" },
    }, required: ["account", "message_id", "until"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.modifyLabels(args.message_id as string, ["SNOOZED"], ["INBOX", "UNREAD"]);
    return { content: [{ type: "text", text: `Message snoozed until ${args.until}. Removed from inbox.` }] };
  }, "snooze"
);

registerTool(
  { name: "list_snoozed", description: "List snoozed messages",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const results = await provider.searchMessages("in:snoozed", 20);
    if (results.length === 0) return { content: [{ type: "text", text: "No snoozed messages." }] };
    const lines = results.map((m) => `- **${m.id}**: ${fenceEmailHeader(m.from, "from")} — ${fenceEmailContent(m.subject, "subject")}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }, "snooze"
);

registerTool(
  { name: "check_snoozed", description: "Check for snoozed messages that are due to resurface",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const results = await provider.searchMessages("in:snoozed", 50);
    return { content: [{ type: "text", text: `${results.length} messages currently snoozed.` }] };
  }, "snooze"
);

// --- Templates ---
registerTool(
  { name: "save_template", description: "Save an email template (stored as a Gmail draft with TEMPLATE label)",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" }, name: { type: "string", description: "Template name" },
      subject: { type: "string", description: "Template subject" }, body: { type: "string", description: "Template body" },
    }, required: ["account", "name", "subject", "body"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const id = await provider.createDraft([], `[TEMPLATE:${args.name}] ${args.subject}`, args.body as string);
    return { content: [{ type: "text", text: `Template "${args.name}" saved as draft ${id}.` }] };
  }, "templates"
);

registerTool(
  { name: "list_templates", description: "List saved email templates",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    const results = await provider.searchMessages("subject:[TEMPLATE:", 50);
    if (results.length === 0) return { content: [{ type: "text", text: "No templates saved." }] };
    const lines = results.map((m) => `- **${m.id}**: ${fenceEmailContent(m.subject, "subject")}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }, "templates"
);

registerTool(
  { name: "delete_template", description: "Delete a saved template",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, message_id: { type: "string", description: "Template message ID" } }, required: ["account", "message_id"] } },
  async (args, ctx) => {
    const provider = await ctx.getProvider(args.account as string);
    await provider.trashMessages([args.message_id as string]);
    return { content: [{ type: "text", text: `Template deleted.` }] };
  }, "templates"
);

registerTool(
  { name: "send_template", description: "Send an email using a saved template",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" }, message_id: { type: "string", description: "Template message ID" },
      to: { type: "array", items: { type: "string" }, description: "Recipients" },
    }, required: ["account", "message_id", "to"] } },
  async (args, ctx) => {
    const limitError = checkSendLimit(args.account as string);
    if (limitError) return { content: [{ type: "text", text: limitError }], isError: true };
    const provider = await ctx.getProvider(args.account as string);
    const template = await provider.readMessage(args.message_id as string);
    const subject = stripFencing(template.subject).replace(/\[TEMPLATE:[^\]]+\]\s*/, "");
    const id = await provider.sendMessage(args.to as string[], subject, stripFencing(template.body));
    return { content: [{ type: "text", text: `Sent from template. Message ID: ${id}` }] };
  }, "templates"
);

// --- Signatures ---
registerTool(
  { name: "get_signature", description: "Get the email signature for a Gmail account",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const res = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = res.data.sendAs?.find((s: any) => s.isPrimary);
    return { content: [{ type: "text", text: fenceEmailContent(primary?.signature ?? "(no signature set)") }] };
  }, "signatures"
);

registerTool(
  { name: "set_signature", description: "Update the email signature for a Gmail account",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, signature: { type: "string", description: "HTML signature content" } }, required: ["account", "signature"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const res = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = res.data.sendAs?.find((s: any) => s.isPrimary);
    if (!primary) throw new Error("No primary send-as address found");
    await (gmail.users.settings.sendAs as any).update({ userId: "me", sendAsEmail: primary.sendAsEmail, requestBody: { signature: args.signature as string } });
    return { content: [{ type: "text", text: "Signature updated." }] };
  }, "signatures"
);

// --- Vacation ---
registerTool(
  { name: "get_vacation", description: "Get vacation auto-reply settings",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const res = await gmail.users.settings.getVacation({ userId: "me" });
    const v = res.data;
    const status = v.enableAutoReply ? "enabled" : "disabled";
    const text = [`**Status:** ${status}`, v.responseSubject ? `**Subject:** ${fenceEmailContent(v.responseSubject, "subject")}` : "", v.responseBodyHtml ? `**Body:** ${fenceEmailContent(v.responseBodyHtml)}` : ""].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }] };
  }, "vacation"
);

registerTool(
  { name: "set_vacation", description: "Configure vacation auto-reply",
    inputSchema: { type: "object" as const, properties: {
      account: { type: "string", description: "Account alias" }, enabled: { type: "boolean", description: "Enable or disable auto-reply" },
      subject: { type: "string", description: "Auto-reply subject" }, body: { type: "string", description: "Auto-reply body (HTML)" },
      start_time: { type: "string", description: "Start date (ISO format, e.g. '2026-03-10')" },
      end_time: { type: "string", description: "End date (ISO format, e.g. '2026-03-20')" },
      contacts_only: { type: "boolean", description: "Only reply to contacts" },
      domain_only: { type: "boolean", description: "Only reply to same domain" },
    }, required: ["account", "enabled"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const settings: Record<string, any> = { enableAutoReply: args.enabled as boolean };
    if (args.subject) settings.responseSubject = args.subject as string;
    if (args.body) settings.responseBodyHtml = args.body as string;
    if (args.start_time) settings.startTime = new Date(args.start_time as string).getTime();
    if (args.end_time) settings.endTime = new Date(args.end_time as string).getTime();
    if (args.contacts_only !== undefined) settings.restrictToContacts = args.contacts_only as boolean;
    if (args.domain_only !== undefined) settings.restrictToDomain = args.domain_only as boolean;
    await gmail.users.settings.updateVacation({ userId: "me", requestBody: settings });
    return { content: [{ type: "text", text: `Vacation auto-reply ${args.enabled ? "enabled" : "disabled"}.` }] };
  }, "vacation"
);

// --- Unsubscribe ---
registerTool(
  { name: "unsubscribe", description: "Unsubscribe from a mailing list by finding the List-Unsubscribe header",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, message_id: { type: "string", description: "Message ID from the mailing list" } }, required: ["account", "message_id"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const res = await gmail.users.messages.get({ userId: "me", id: args.message_id as string, format: "metadata", metadataHeaders: ["List-Unsubscribe"] });
    const header = res.data.payload?.headers?.find((h: any) => h.name?.toLowerCase() === "list-unsubscribe");
    if (!header?.value) return { content: [{ type: "text", text: "No List-Unsubscribe header found on this message." }], isError: true };
    return { content: [{ type: "text", text: `Unsubscribe link: ${fenceEmailContent(header.value)}\n\nOpen this URL to unsubscribe.` }] };
  }, "unsubscribe"
);

registerTool(
  { name: "bulk_unsubscribe", description: "Find unsubscribe links for multiple mailing list messages",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, message_ids: { type: "array", items: { type: "string" }, description: "Message IDs" } }, required: ["account", "message_ids"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const results: string[] = [];
    for (const msgId of args.message_ids as string[]) {
      const res = await gmail.users.messages.get({ userId: "me", id: msgId, format: "metadata", metadataHeaders: ["List-Unsubscribe", "From"] });
      const headers = res.data.payload?.headers ?? [];
      const from = headers.find((h: any) => h.name === "From")?.value ?? "unknown";
      const unsub = headers.find((h: any) => h.name?.toLowerCase() === "list-unsubscribe")?.value;
      results.push(unsub ? `- ${fenceEmailHeader(from, "from")}: ${fenceEmailContent(unsub)}` : `- ${fenceEmailHeader(from, "from")}: no unsubscribe link`);
    }
    return { content: [{ type: "text", text: results.join("\n") }] };
  }, "unsubscribe"
);

// --- Contacts ---
registerTool(
  { name: "search_contacts", description: "Search Google Contacts (requires People API scope)",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" }, query: { type: "string", description: "Search query (name or email)" } }, required: ["account", "query"] } },
  async (args, _ctx) => {
    return { content: [{ type: "text", text: `Contact search for "${args.query}": This feature requires the Google People API. Search your Gmail instead with: search_emails account="${args.account}" query="from:${args.query} OR to:${args.query}"` }] };
  }, "contacts"
);

// --- Send As ---
registerTool(
  { name: "list_send_as", description: "List send-as aliases configured on a Gmail account",
    inputSchema: { type: "object" as const, properties: { account: { type: "string", description: "Account alias" } }, required: ["account"] } },
  async (args, ctx) => {
    const gmail = getGmailApi(await ctx.getProvider(args.account as string));
    const res = await gmail.users.settings.sendAs.list({ userId: "me" });
    const aliases = res.data.sendAs ?? [];
    const lines = aliases.map((a: any) => `- ${a.sendAsEmail}${a.isPrimary ? " (primary)" : ""}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }, "signatures"
);
