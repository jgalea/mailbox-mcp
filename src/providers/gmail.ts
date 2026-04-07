import { fenceEmailContent } from "../security/sanitize.js";

// Lightweight types matching the gmail_v1 shapes we use, to avoid importing
// the massive googleapis type definitions (which add ~2min to tsc builds).
interface GmailMessagePartHeader { name?: string | null; value?: string | null; }
interface GmailMessagePartBody { data?: string | null; attachmentId?: string | null; size?: number | null; }
interface GmailMessagePart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailMessagePartHeader[] | null;
  body?: GmailMessagePartBody | null;
  parts?: GmailMessagePart[] | null;
}
interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  payload?: GmailMessagePart | null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmailClient = any;
import { stripCRLF } from "../security/validation.js";
import type {
  MailProvider, ProviderCapabilities, EmailSummary, EmailMessage,
  EmailThread, Label, SendOptions, ReplyOptions, ForwardOptions,
  DraftOptions, AttachmentInfo,
} from "./interface.js";

function getHeader(headers: GmailMessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(payload: GmailMessagePart): string {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart) return decodeBody(textPart);
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart) return decodeBody(htmlPart);
    for (const part of payload.parts) {
      const nested = decodeBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

function extractAttachments(payload: GmailMessagePart): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  if (payload.filename && payload.body?.attachmentId) {
    attachments.push({
      id: payload.body.attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body.size ?? 0,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part));
    }
  }
  return attachments;
}

function parseMessage(data: GmailMessage, fence: boolean = false): EmailMessage {
  const headers = data.payload?.headers ?? [];
  const body = decodeBody(data.payload!);
  const attachments = extractAttachments(data.payload!);

  return {
    id: data.id!,
    threadId: data.threadId ?? undefined,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To").split(",").map((s) => s.trim()).filter(Boolean),
    cc: getHeader(headers, "Cc").split(",").map((s) => s.trim()).filter(Boolean),
    bcc: getHeader(headers, "Bcc").split(",").map((s) => s.trim()).filter(Boolean),
    replyTo: getHeader(headers, "Reply-To") || undefined,
    subject: fence ? fenceEmailContent(getHeader(headers, "Subject"), "subject") : getHeader(headers, "Subject"),
    snippet: data.snippet ?? "",
    date: getHeader(headers, "Date"),
    labels: data.labelIds ?? [],
    hasAttachments: attachments.length > 0,
    body: fence ? fenceEmailContent(body) : body,
    attachments,
  };
}

function toSummary(msg: EmailMessage): EmailSummary {
  return {
    id: msg.id, threadId: msg.threadId, from: msg.from, to: msg.to,
    subject: msg.subject, snippet: msg.snippet, date: msg.date,
    labels: msg.labels, hasAttachments: msg.hasAttachments,
  };
}

function encodeEmail(
  to: string[], subject: string, body: string,
  options?: SendOptions & { inReplyTo?: string; references?: string }
): string {
  const headers = [
    `To: ${stripCRLF(to.join(", "))}`,
    `Subject: ${stripCRLF(subject)}`,
    `MIME-Version: 1.0`,
  ];
  if (options?.cc?.length) headers.push(`Cc: ${stripCRLF(options.cc.join(", "))}`);
  if (options?.bcc?.length) headers.push(`Bcc: ${stripCRLF(options.bcc.join(", "))}`);
  if (options?.replyTo) headers.push(`Reply-To: ${stripCRLF(options.replyTo)}`);
  if (options?.inReplyTo) headers.push(`In-Reply-To: ${stripCRLF(options.inReplyTo)}`);
  if (options?.references) headers.push(`References: ${stripCRLF(options.references)}`);

  const contentType = options?.html
    ? "Content-Type: text/html; charset=utf-8"
    : "Content-Type: text/plain; charset=utf-8";
  headers.push(contentType);

  const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(raw).toString("base64url");
}

export class GmailProvider implements MailProvider {
  readonly type = "gmail";
  readonly capabilities: ProviderCapabilities = {
    threads: true, filters: true, snooze: true, templates: true,
    signatures: true, vacation: true, contacts: true, unsubscribe: true,
    attachments: true, inboxSummary: true,
  };

  constructor(private gmail: GmailClient) {}

  async searchMessages(query: string, maxResults: number = 20): Promise<EmailSummary[]> {
    const res = await this.gmail.users.messages.list({ userId: "me", q: query, maxResults });
    const messages = res.data.messages ?? [];
    const results: EmailSummary[] = [];
    for (const msg of messages) {
      const full = await this.gmail.users.messages.get({
        userId: "me", id: msg.id!, format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      results.push(toSummary(parseMessage(full.data)));
    }
    return results;
  }

  async readMessage(messageId: string): Promise<EmailMessage> {
    return this.fetchMessage(messageId, true);
  }

  /** Fetch message without prompt-injection fencing, for use in forward/reply outgoing content. */
  private async fetchMessage(messageId: string, fence: boolean): Promise<EmailMessage> {
    const res = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    return parseMessage(res.data, fence);
  }

  async readThread(threadId: string): Promise<EmailThread> {
    const res = await this.gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = (res.data.messages ?? []).map((m: GmailMessage) => parseMessage(m, true));
    return { id: threadId, subject: messages[0]?.subject ?? "", messages };
  }

  async sendMessage(to: string[], subject: string, body: string, options?: SendOptions): Promise<string> {
    const raw = encodeEmail(to, subject, body, options);
    const res = await this.gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return res.data.id!;
  }

  async replyToMessage(messageId: string, body: string, options?: ReplyOptions): Promise<string> {
    const original = await this.gmail.users.messages.get({
      userId: "me", id: messageId, format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "Reply-To"],
    });
    const headers = original.data.payload?.headers ?? [];
    const from = getHeader(headers, "From");
    const replyTo = getHeader(headers, "Reply-To");
    const to = getHeader(headers, "To");
    const cc = getHeader(headers, "Cc");
    const subject = getHeader(headers, "Subject");
    const msgId = getHeader(headers, "Message-ID");

    const replyAddress = replyTo || from;
    const recipients = options?.replyAll
      ? [replyAddress, ...to.split(","), ...cc.split(",")].map((s) => s.trim()).filter(Boolean)
      : [replyAddress];

    const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
    const raw = encodeEmail(recipients, reSubject, body, {
      html: options?.html, inReplyTo: msgId, references: msgId,
    } as any);

    const res = await this.gmail.users.messages.send({
      userId: "me", requestBody: { raw, threadId: original.data.threadId ?? undefined },
    });
    return res.data.id!;
  }

  async forwardMessage(messageId: string, to: string[], options?: ForwardOptions): Promise<string> {
    const original = await this.fetchMessage(messageId, false);
    const fwdBody = options?.message
      ? `${options.message}\n\n---------- Forwarded message ----------\n${original.body}`
      : `---------- Forwarded message ----------\n${original.body}`;
    const fwdSubject = original.subject.startsWith("Fwd:") ? original.subject : `Fwd: ${original.subject}`;
    return this.sendMessage(to, fwdSubject, fwdBody, { html: options?.html });
  }

  async createDraft(to: string[], subject: string, body: string, options?: DraftOptions): Promise<string> {
    let threadId: string | undefined;
    let replyHeaders: { inReplyTo?: string; references?: string } | undefined;

    if (options?.inReplyTo) {
      const original = await this.gmail.users.messages.get({
        userId: "me", id: options.inReplyTo, format: "metadata",
        metadataHeaders: ["Message-ID", "References"],
      });
      const headers = original.data.payload?.headers ?? [];
      const origMessageId = getHeader(headers, "Message-ID");
      const origReferences = getHeader(headers, "References");
      threadId = original.data.threadId ?? undefined;
      replyHeaders = {
        inReplyTo: origMessageId,
        references: origReferences ? `${origReferences} ${origMessageId}` : origMessageId,
      };
    }

    const raw = encodeEmail(to, subject, body, { ...options, ...replyHeaders });
    const res = await this.gmail.users.drafts.create({
      userId: "me", requestBody: { message: { raw, threadId } },
    });
    return res.data.id!;
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      await this.gmail.users.messages.trash({ userId: "me", id });
    }
  }

  async listLabels(): Promise<Label[]> {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    return (res.data.labels ?? []).map((l: any) => ({
      id: l.id!, name: l.name!,
      type: (l.type === "system" ? "system" : "user") as "system" | "user",
    }));
  }

  async createLabel(name: string): Promise<Label> {
    const res = await this.gmail.users.labels.create({
      userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return { id: res.data.id!, name: res.data.name!, type: "user" };
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.gmail.users.labels.delete({ userId: "me", id: labelId });
  }

  async modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: "me", id: messageId, requestBody: { addLabelIds: add, removeLabelIds: remove },
    });
  }

  async batchModifyLabels(messageIds: string[], add: string[], remove: string[]): Promise<void> {
    for (const id of messageIds) {
      await this.modifyLabels(id, add, remove);
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<{ filename: string; data: Buffer; mimeType: string }> {
    const msg = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const attachments = extractAttachments(msg.data.payload!);
    const info = attachments.find((a) => a.id === attachmentId);
    if (!info) throw new Error(`Attachment ${attachmentId} not found`);
    const res = await this.gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    return { filename: info.filename, data: Buffer.from(res.data.data!, "base64url"), mimeType: info.mimeType };
  }

  async inboxSummary(): Promise<{ total: number; unread: number; recent: EmailSummary[] }> {
    const [totalRes, unreadRes] = await Promise.all([
      this.gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: 1 }),
      this.gmail.users.messages.list({ userId: "me", q: "in:inbox is:unread", maxResults: 1 }),
    ]);
    const recent = await this.searchMessages("in:inbox", 5);
    return {
      total: totalRes.data.resultSizeEstimate ?? 0,
      unread: unreadRes.data.resultSizeEstimate ?? 0,
      recent,
    };
  }

  get gmailApi() { return this.gmail; }
}
