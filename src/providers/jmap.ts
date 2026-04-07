// src/providers/jmap.ts
import { fenceEmailContent } from "../security/sanitize.js";
import { stripCRLF, validateNoSSRF } from "../security/validation.js";
import type {
  MailProvider, ProviderCapabilities, EmailSummary, EmailMessage,
  EmailThread, Label, SendOptions, ReplyOptions, ForwardOptions,
  DraftOptions, AttachmentInfo,
} from "./interface.js";

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accountId: string;
}

interface JmapAddress {
  name?: string;
  email: string;
}

/** Validate that a URL uses HTTPS and does not target private/internal networks. */
function requireSecureUrl(url: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context}: invalid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${context}: HTTPS required, got ${parsed.protocol}`);
  }
  validateNoSSRF(url);
}

function formatJmapAddress(addr: JmapAddress | undefined): string {
  if (!addr) return "";
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

function formatJmapAddresses(addrs: JmapAddress[] | undefined): string[] {
  return (addrs ?? []).map(formatJmapAddress).filter(Boolean);
}

export class JmapProvider implements MailProvider {
  readonly type = "jmap";
  readonly capabilities: ProviderCapabilities = {
    threads: true, filters: false, snooze: false, templates: false,
    signatures: false, vacation: false, contacts: false, unsubscribe: false,
    attachments: true, inboxSummary: true,
  };

  private session: JmapSession | null = null;
  private authHeader: string;

  constructor(
    private host: string,
    private email: string,
    username: string,
    password: string,
    private sessionUrl?: string,
  ) {
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  private async ensureSession(): Promise<JmapSession> {
    if (this.session) return this.session;

    const url = this.sessionUrl ?? `https://${this.host}/.well-known/jmap`;
    requireSecureUrl(url, "JMAP session URL");

    const res = await fetch(url, {
      headers: { Authorization: this.authHeader },
      redirect: "error", // Prevent redirect-based SSRF
    });
    if (!res.ok) {
      throw new Error(`JMAP session discovery failed: ${res.status}`);
    }

    const data = await res.json() as any;
    const accountId = data.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (!accountId) {
      throw new Error("JMAP session has no mail account");
    }

    // Validate all server-provided URLs before trusting them
    const apiUrl = data.apiUrl;
    const downloadUrl = data.downloadUrl;
    const uploadUrl = data.uploadUrl;

    if (!apiUrl || typeof apiUrl !== "string") throw new Error("JMAP session missing apiUrl");
    if (!downloadUrl || typeof downloadUrl !== "string") throw new Error("JMAP session missing downloadUrl");
    if (!uploadUrl || typeof uploadUrl !== "string") throw new Error("JMAP session missing uploadUrl");

    requireSecureUrl(apiUrl, "JMAP apiUrl");
    // downloadUrl/uploadUrl are templates with {placeholders}; validate the base origin
    requireSecureUrl(downloadUrl.replace(/\{[^}]+\}/g, "placeholder"), "JMAP downloadUrl");
    requireSecureUrl(uploadUrl.replace(/\{[^}]+\}/g, "placeholder"), "JMAP uploadUrl");

    this.session = { apiUrl, downloadUrl, uploadUrl, accountId };
    return this.session;
  }

  private async apiCall(methodCalls: any[][]): Promise<any[][]> {
    const session = await this.ensureSession();
    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls,
      }),
      redirect: "error",
    });
    if (!res.ok) {
      throw new Error(`JMAP API error: ${res.status}`);
    }
    const body = await res.json() as any;
    return body.methodResponses;
  }

  async searchMessages(query: string, maxResults: number = 20): Promise<EmailSummary[]> {
    const session = await this.ensureSession();
    const responses = await this.apiCall([
      ["Email/query", {
        accountId: session.accountId,
        filter: { text: query },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: maxResults,
      }, "0"],
      ["Email/get", {
        accountId: session.accountId,
        "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
        properties: ["id", "threadId", "from", "to", "subject", "preview", "receivedAt", "mailboxIds", "hasAttachment"],
      }, "1"],
    ]);

    const emails = responses.find((r: any) => r[0] === "Email/get")?.[1]?.list ?? [];
    return emails.map((e: any) => ({
      id: e.id,
      threadId: e.threadId,
      from: formatJmapAddress(e.from?.[0]),
      to: formatJmapAddresses(e.to),
      subject: e.subject ?? "",
      snippet: e.preview ?? "",
      date: e.receivedAt ?? "",
      labels: Object.keys(e.mailboxIds ?? {}),
      hasAttachments: e.hasAttachment ?? false,
    }));
  }

  async readMessage(messageId: string): Promise<EmailMessage> {
    return this.fetchMessage(messageId, true);
  }

  private async fetchMessage(messageId: string, fence: boolean): Promise<EmailMessage> {
    const session = await this.ensureSession();
    const responses = await this.apiCall([
      ["Email/get", {
        accountId: session.accountId,
        ids: [messageId],
        properties: [
          "id", "threadId", "from", "to", "cc", "bcc", "replyTo",
          "subject", "preview", "receivedAt", "mailboxIds",
          "hasAttachment", "textBody", "bodyValues", "attachments",
        ],
        fetchTextBodyValues: true,
      }, "0"],
    ]);

    const list = responses.find((r: any) => r[0] === "Email/get")?.[1]?.list ?? [];
    if (list.length === 0) throw new Error(`Message ${messageId} not found`);
    const e = list[0];

    const bodyPartId = e.textBody?.[0]?.partId;
    const bodyText = bodyPartId ? (e.bodyValues?.[bodyPartId]?.value ?? "") : "";
    const subject = e.subject ?? "";

    return {
      id: e.id,
      threadId: e.threadId,
      from: formatJmapAddress(e.from?.[0]),
      to: formatJmapAddresses(e.to),
      cc: formatJmapAddresses(e.cc),
      bcc: formatJmapAddresses(e.bcc),
      replyTo: formatJmapAddress(e.replyTo?.[0]) || undefined,
      subject: fence ? fenceEmailContent(subject, "subject") : subject,
      snippet: e.preview ?? "",
      date: e.receivedAt ?? "",
      labels: Object.keys(e.mailboxIds ?? {}),
      hasAttachments: e.hasAttachment ?? false,
      body: fence ? fenceEmailContent(bodyText) : bodyText,
      attachments: (e.attachments ?? []).map((a: any) => ({
        id: a.blobId,
        filename: a.name ?? "attachment",
        mimeType: a.type ?? "application/octet-stream",
        size: a.size ?? 0,
      })),
    };
  }

  async readThread(threadId: string): Promise<EmailThread> {
    const session = await this.ensureSession();
    const responses = await this.apiCall([
      ["Thread/get", {
        accountId: session.accountId,
        ids: [threadId],
      }, "0"],
      ["Email/get", {
        accountId: session.accountId,
        "#ids": { resultOf: "0", name: "Thread/get", path: "/list/*/emailIds" },
        properties: [
          "id", "threadId", "from", "to", "cc", "bcc", "replyTo",
          "subject", "preview", "receivedAt", "mailboxIds",
          "hasAttachment", "textBody", "bodyValues", "attachments",
        ],
        fetchTextBodyValues: true,
      }, "1"],
    ]);

    const threads = responses.find((r: any) => r[0] === "Thread/get")?.[1]?.list ?? [];
    if (threads.length === 0) throw new Error(`Thread ${threadId} not found`);

    const emails = responses.find((r: any) => r[0] === "Email/get")?.[1]?.list ?? [];
    const messages: EmailMessage[] = emails.map((e: any) => {
      const bodyPartId = e.textBody?.[0]?.partId;
      const bodyText = bodyPartId ? (e.bodyValues?.[bodyPartId]?.value ?? "") : "";
      return {
        id: e.id,
        threadId: e.threadId,
        from: formatJmapAddress(e.from?.[0]),
        to: formatJmapAddresses(e.to),
        cc: formatJmapAddresses(e.cc),
        bcc: formatJmapAddresses(e.bcc),
        replyTo: formatJmapAddress(e.replyTo?.[0]) || undefined,
        subject: fenceEmailContent(e.subject ?? "", "subject"),
        snippet: e.preview ?? "",
        date: e.receivedAt ?? "",
        labels: Object.keys(e.mailboxIds ?? {}),
        hasAttachments: e.hasAttachment ?? false,
        body: fenceEmailContent(bodyText),
        attachments: (e.attachments ?? []).map((a: any) => ({
          id: a.blobId,
          filename: a.name ?? "attachment",
          mimeType: a.type ?? "application/octet-stream",
          size: a.size ?? 0,
        })),
      };
    });

    return {
      id: threadId,
      subject: messages[0]?.subject ?? "",
      messages,
    };
  }

  async inboxSummary(): Promise<{ total: number; unread: number; recent: EmailSummary[] }> {
    const session = await this.ensureSession();

    // Step 1: Find inbox mailbox and get counts
    const mboxResponses = await this.apiCall([
      ["Mailbox/query", {
        accountId: session.accountId,
        filter: { role: "inbox" },
      }, "0"],
      ["Mailbox/get", {
        accountId: session.accountId,
        "#ids": { resultOf: "0", name: "Mailbox/query", path: "/ids" },
        properties: ["id", "name", "role", "totalEmails", "unreadEmails"],
      }, "1"],
    ]);

    const mailboxes = mboxResponses.find((r: any) => r[0] === "Mailbox/get")?.[1]?.list ?? [];
    const inbox = mailboxes[0];
    if (!inbox) return { total: 0, unread: 0, recent: [] };

    // Step 2: Get recent emails filtered to inbox
    const emailResponses = await this.apiCall([
      ["Email/query", {
        accountId: session.accountId,
        filter: { inMailbox: inbox.id },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 5,
      }, "0"],
      ["Email/get", {
        accountId: session.accountId,
        "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
        properties: ["id", "threadId", "from", "to", "subject", "preview", "receivedAt", "mailboxIds", "hasAttachment"],
      }, "1"],
    ]);

    const emails = emailResponses.find((r: any) => r[0] === "Email/get")?.[1]?.list ?? [];
    const recent = emails.map((e: any) => ({
      id: e.id,
      threadId: e.threadId,
      from: formatJmapAddress(e.from?.[0]),
      to: formatJmapAddresses(e.to),
      subject: e.subject ?? "",
      snippet: e.preview ?? "",
      date: e.receivedAt ?? "",
      labels: Object.keys(e.mailboxIds ?? {}),
      hasAttachments: e.hasAttachment ?? false,
    }));

    return {
      total: inbox?.totalEmails ?? 0,
      unread: inbox?.unreadEmails ?? 0,
      recent,
    };
  }

  private async findMailboxByRole(role: string): Promise<{ id: string; name: string }> {
    const session = await this.ensureSession();
    const responses = await this.apiCall([
      ["Mailbox/query", { accountId: session.accountId, filter: { role } }, "0"],
      ["Mailbox/get", {
        accountId: session.accountId,
        "#ids": { resultOf: "0", name: "Mailbox/query", path: "/ids" },
        properties: ["id", "name", "role"],
      }, "1"],
    ]);
    const list = responses.find((r: any) => r[0] === "Mailbox/get")?.[1]?.list ?? [];
    if (list.length === 0) throw new Error(`Mailbox with role "${role}" not found`);
    return { id: list[0].id, name: list[0].name };
  }

  async sendMessage(to: string[], subject: string, body: string, options?: SendOptions): Promise<string> {
    const session = await this.ensureSession();
    const emailCreate: any = {
      from: [{ email: this.email }],
      to: to.map(e => ({ email: stripCRLF(e) })),
      subject: stripCRLF(subject),
      textBody: [{ value: body, type: "text/plain" }],
    };
    if (options?.cc) emailCreate.cc = options.cc.map(e => ({ email: stripCRLF(e) }));
    if (options?.bcc) emailCreate.bcc = options.bcc.map(e => ({ email: stripCRLF(e) }));
    if (options?.html) {
      emailCreate.htmlBody = [{ value: body, type: "text/html" }];
      delete emailCreate.textBody;
    }
    const responses = await this.apiCall([
      ["Email/set", { accountId: session.accountId, create: { draft0: emailCreate } }, "0"],
      ["EmailSubmission/set", { accountId: session.accountId, create: { sub0: { emailId: "#draft0" } } }, "1"],
    ]);
    const created = responses.find((r: any) => r[0] === "Email/set")?.[1]?.created?.draft0;
    return created?.id ?? "";
  }

  async replyToMessage(messageId: string, body: string, options?: ReplyOptions): Promise<string> {
    const original = await this.fetchMessage(messageId, false);
    const to = [original.from];
    if (options?.replyAll) { to.push(...original.to, ...original.cc); }
    const subject = original.subject.includes("Re:") ? original.subject : `Re: ${original.subject}`;
    return this.sendMessage(to, subject, body, { html: options?.html });
  }

  async forwardMessage(messageId: string, to: string[], options?: ForwardOptions): Promise<string> {
    const original = await this.fetchMessage(messageId, false);
    const fwdBody = options?.message
      ? `${options.message}\n\n---------- Forwarded message ----------\n${original.body}`
      : `---------- Forwarded message ----------\n${original.body}`;
    const subject = original.subject.includes("Fwd:") ? original.subject : `Fwd: ${original.subject}`;
    return this.sendMessage(to, subject, fwdBody, { html: options?.html });
  }

  async createDraft(to: string[], subject: string, body: string, options?: DraftOptions): Promise<string> {
    const session = await this.ensureSession();
    const draftsMailbox = await this.findMailboxByRole("drafts");
    const emailCreate: any = {
      from: [{ email: this.email }],
      to: to.map(e => ({ email: stripCRLF(e) })),
      subject: stripCRLF(subject),
      mailboxIds: { [draftsMailbox.id]: true },
      keywords: { $draft: true },
      textBody: [{ value: body, type: "text/plain" }],
    };
    if (options?.cc) emailCreate.cc = options.cc.map(e => ({ email: stripCRLF(e) }));
    if (options?.bcc) emailCreate.bcc = options.bcc.map(e => ({ email: stripCRLF(e) }));
    if (options?.html) {
      emailCreate.htmlBody = [{ value: body, type: "text/html" }];
      delete emailCreate.textBody;
    }
    if (options?.inReplyTo) emailCreate.inReplyTo = options.inReplyTo;
    const responses = await this.apiCall([
      ["Email/set", { accountId: session.accountId, create: { draft0: emailCreate } }, "0"],
    ]);
    const created = responses.find((r: any) => r[0] === "Email/set")?.[1]?.created?.draft0;
    return created?.id ?? "";
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    const session = await this.ensureSession();
    const trashMailbox = await this.findMailboxByRole("trash");
    const update: Record<string, any> = {};
    for (const id of messageIds) {
      update[id] = { mailboxIds: { [trashMailbox.id]: true } };
    }
    await this.apiCall([
      ["Email/set", { accountId: session.accountId, update }, "0"],
    ]);
  }

  async listLabels(): Promise<Label[]> {
    const session = await this.ensureSession();
    const responses = await this.apiCall([
      ["Mailbox/get", { accountId: session.accountId, properties: ["id", "name", "role"] }, "0"],
    ]);
    const list = responses.find((r: any) => r[0] === "Mailbox/get")?.[1]?.list ?? [];
    return list.map((m: any) => ({
      id: m.id, name: m.name,
      type: m.role ? ("system" as const) : ("user" as const),
    }));
  }

  async createLabel(name: string): Promise<Label> {
    const session = await this.ensureSession();
    const responses = await this.apiCall([
      ["Mailbox/set", { accountId: session.accountId, create: { mbox0: { name } } }, "0"],
    ]);
    const created = responses.find((r: any) => r[0] === "Mailbox/set")?.[1]?.created?.mbox0;
    return { id: created?.id ?? "", name, type: "user" };
  }

  async deleteLabel(labelId: string): Promise<void> {
    const session = await this.ensureSession();
    await this.apiCall([
      ["Mailbox/set", { accountId: session.accountId, destroy: [labelId] }, "0"],
    ]);
  }

  async modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void> {
    const session = await this.ensureSession();
    const update: Record<string, any> = {};
    for (const mboxId of add) { update[`mailboxIds/${mboxId}`] = true; }
    for (const mboxId of remove) { update[`mailboxIds/${mboxId}`] = null; }
    await this.apiCall([
      ["Email/set", { accountId: session.accountId, update: { [messageId]: update } }, "0"],
    ]);
  }

  async batchModifyLabels(messageIds: string[], add: string[], remove: string[]): Promise<void> {
    const session = await this.ensureSession();
    const patch: Record<string, any> = {};
    for (const mboxId of add) { patch[`mailboxIds/${mboxId}`] = true; }
    for (const mboxId of remove) { patch[`mailboxIds/${mboxId}`] = null; }
    const update: Record<string, any> = {};
    for (const id of messageIds) { update[id] = { ...patch }; }
    await this.apiCall([
      ["Email/set", { accountId: session.accountId, update }, "0"],
    ]);
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<{ filename: string; data: Buffer; mimeType: string }> {
    const session = await this.ensureSession();
    const msg = await this.fetchMessage(messageId, false);
    const attachment = msg.attachments.find(a => a.id === attachmentId);
    if (!attachment) throw new Error(`Attachment ${attachmentId} not found`);
    const url = session.downloadUrl
      .replace("{accountId}", encodeURIComponent(session.accountId))
      .replace("{blobId}", encodeURIComponent(attachmentId))
      .replace("{name}", encodeURIComponent(attachment.filename))
      .replace("{type}", encodeURIComponent(attachment.mimeType));
    requireSecureUrl(url, "JMAP download URL");
    const res = await fetch(url, { headers: { Authorization: this.authHeader }, redirect: "error" });
    if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { filename: attachment.filename, data: buffer, mimeType: attachment.mimeType };
  }
}
