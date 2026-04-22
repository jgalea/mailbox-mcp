import { Readable } from "node:stream";
import { buildRawMimeMessage } from "./mime.js";
import { ensureReplyPrefix, ensureForwardPrefix, splitAddressList } from "./headers.js";

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
import type {
  MailProvider, ProviderCapabilities, EmailSummary, EmailMessage,
  EmailThread, Label, SendOptions, ReplyOptions, ForwardOptions,
  DraftOptions, AttachmentInfo, DraftSummary, UnreadCount, ExportedMessage,
} from "./interface.js";

function getHeader(headers: GmailMessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function* chunkIds(ids: string[], size: number): Generator<string[]> {
  for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
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

function parseMessage(data: GmailMessage): EmailMessage {
  const headers = data.payload?.headers ?? [];
  const body = decodeBody(data.payload!);
  const attachments = extractAttachments(data.payload!);

  return {
    id: data.id!,
    threadId: data.threadId ?? undefined,
    from: getHeader(headers, "From"),
    to: splitAddressList(getHeader(headers, "To")),
    cc: splitAddressList(getHeader(headers, "Cc")),
    bcc: splitAddressList(getHeader(headers, "Bcc")),
    replyTo: getHeader(headers, "Reply-To") || undefined,
    subject: getHeader(headers, "Subject"),
    snippet: data.snippet ?? "",
    date: getHeader(headers, "Date"),
    labels: data.labelIds ?? [],
    hasAttachments: attachments.length > 0,
    body,
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

export type GmailEncodeOptions = SendOptions & { inReplyTo?: string; references?: string };

export function buildEmailBuffer(to: string[], subject: string, body: string, options?: GmailEncodeOptions): Buffer {
  return buildRawMimeMessage({
    to, subject, body,
    cc: options?.cc, bcc: options?.bcc,
    replyTo: options?.replyTo,
    inReplyTo: options?.inReplyTo,
    references: options?.references,
    html: options?.html,
    attachments: options?.attachments,
  });
}

/**
 * Gmail's JSON endpoints accept the raw RFC 2822 message as a base64url
 * string up to ~10 MB total payload. Messages with binary attachments are
 * better served by the multipart upload endpoint, which supports up to
 * 35 MB. We flip to media upload whenever attachments are present or the
 * raw payload is large enough to risk the JSON limit.
 */
const MEDIA_UPLOAD_THRESHOLD = 3 * 1024 * 1024;
export function shouldUseMediaUpload(raw: Buffer, options?: GmailEncodeOptions): boolean {
  if (options?.attachments && options.attachments.length > 0) return true;
  return raw.length > MEDIA_UPLOAD_THRESHOLD;
}

export class GmailProvider implements MailProvider {
  readonly type = "gmail";
  readonly capabilities: ProviderCapabilities = {
    threads: true, filters: true, templates: true,
    signatures: true, vacation: true, unsubscribe: true,
    attachments: true, inboxSummary: true,
  };

  constructor(private gmail: GmailClient) {}

  async searchMessages(query: string, maxResults: number = 20, folder?: string): Promise<EmailSummary[]> {
    const q = folder ? `label:${folder} ${query}`.trim() : query;
    const res = await this.gmail.users.messages.list({ userId: "me", q, maxResults });
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
    return this.fetchMessage(messageId);
  }

  private async fetchMessage(messageId: string): Promise<EmailMessage> {
    const res = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    return parseMessage(res.data);
  }

  async readThread(threadId: string): Promise<EmailThread> {
    const res = await this.gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = (res.data.messages ?? []).map((m: GmailMessage) => parseMessage(m));
    return { id: threadId, subject: messages[0]?.subject ?? "", messages };
  }

  async sendMessage(to: string[], subject: string, body: string, options?: SendOptions): Promise<string> {
    const rawBuffer = buildEmailBuffer(to, subject, body, options);
    if (shouldUseMediaUpload(rawBuffer, options)) {
      const res = await this.gmail.users.messages.send({
        userId: "me",
        requestBody: {},
        media: { mimeType: "message/rfc822", body: Readable.from(rawBuffer) },
      });
      return res.data.id!;
    }
    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: rawBuffer.toString("base64url") },
    });
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
      ? [replyAddress, ...splitAddressList(to), ...splitAddressList(cc)].filter(Boolean)
      : [replyAddress];

    const reSubject = ensureReplyPrefix(subject);
    const encodeOpts: GmailEncodeOptions = {
      html: options?.html,
      inReplyTo: msgId,
      references: msgId,
      attachments: options?.attachments,
    };
    const rawBuffer = buildEmailBuffer(recipients, reSubject, body, encodeOpts);
    const threadId = original.data.threadId ?? undefined;
    if (shouldUseMediaUpload(rawBuffer, encodeOpts)) {
      const res = await this.gmail.users.messages.send({
        userId: "me",
        requestBody: { threadId },
        media: { mimeType: "message/rfc822", body: Readable.from(rawBuffer) },
      });
      return res.data.id!;
    }
    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: rawBuffer.toString("base64url"), threadId },
    });
    return res.data.id!;
  }

  async forwardMessage(messageId: string, to: string[], options?: ForwardOptions): Promise<string> {
    const original = await this.fetchMessage(messageId);
    const fwdBody = options?.message
      ? `${options.message}\n\n---------- Forwarded message ----------\n${original.body}`
      : `---------- Forwarded message ----------\n${original.body}`;
    const fwdSubject = ensureForwardPrefix(original.subject);
    return this.sendMessage(to, fwdSubject, fwdBody, { html: options?.html, attachments: options?.attachments });
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

    const encodeOpts: GmailEncodeOptions = { ...options, ...replyHeaders };
    const rawBuffer = buildEmailBuffer(to, subject, body, encodeOpts);
    if (shouldUseMediaUpload(rawBuffer, encodeOpts)) {
      const res = await this.gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { threadId } },
        media: { mimeType: "message/rfc822", body: Readable.from(rawBuffer) },
      });
      return res.data.id!;
    }
    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: rawBuffer.toString("base64url"), threadId } },
    });
    return res.data.id!;
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    // Gmail's batchModify accepts up to 1000 ids per call; adding the TRASH label
    // is equivalent to users.messages.trash but avoids N sequential round trips
    // (which stalls the MCP connection on large batches).
    for (const chunk of chunkIds(messageIds, 1000)) {
      await this.gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: chunk, addLabelIds: ["TRASH"] },
      });
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
    // Single API call per 1000 ids. Previously a per-message loop, which stalled
    // the MCP connection on batches in the hundreds.
    for (const chunk of chunkIds(messageIds, 1000)) {
      await this.gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: chunk, addLabelIds: add, removeLabelIds: remove },
      });
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

  async markRead(messageId: string, read: boolean): Promise<void> {
    if (read) await this.modifyLabels(messageId, [], ["UNREAD"]);
    else await this.modifyLabels(messageId, ["UNREAD"], []);
  }

  async starMessage(messageId: string, starred: boolean): Promise<void> {
    if (starred) await this.modifyLabels(messageId, ["STARRED"], []);
    else await this.modifyLabels(messageId, [], ["STARRED"]);
  }

  async archiveMessage(messageId: string): Promise<void> {
    await this.modifyLabels(messageId, [], ["INBOX"]);
  }

  async listDrafts(maxResults: number = 20): Promise<DraftSummary[]> {
    const res = await this.gmail.users.drafts.list({ userId: "me", maxResults });
    const drafts = res.data.drafts ?? [];
    const results: DraftSummary[] = [];
    for (const d of drafts) {
      const full = await this.gmail.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" });
      const headers = full.data.message?.payload?.headers ?? [];
      results.push({
        id: d.id!,
        messageId: full.data.message?.id ?? undefined,
        subject: getHeader(headers, "Subject"),
        to: splitAddressList(getHeader(headers, "To")),
        snippet: full.data.message?.snippet ?? "",
        updatedAt: full.data.message?.internalDate
          ? new Date(parseInt(full.data.message.internalDate, 10)).toISOString()
          : "",
      });
    }
    return results;
  }

  async sendDraft(draftId: string): Promise<string> {
    const res = await this.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });
    return res.data.id ?? "";
  }

  async countUnreadByLabel(): Promise<UnreadCount[]> {
    const list = await this.gmail.users.labels.list({ userId: "me" });
    const labels = (list.data.labels ?? []) as any[];
    const counts: UnreadCount[] = [];
    for (const l of labels) {
      const detail = await this.gmail.users.labels.get({ userId: "me", id: l.id });
      const unread = detail.data.messagesUnread ?? 0;
      if (unread > 0) {
        counts.push({ labelId: l.id, name: l.name, unread });
      }
    }
    return counts.sort((a, b) => b.unread - a.unread);
  }

  async exportMessage(messageId: string): Promise<ExportedMessage> {
    const res = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "raw" });
    const raw = res.data.raw as string | undefined;
    if (!raw) throw new Error(`Message ${messageId} has no raw content`);
    return {
      filename: `${messageId}.eml`,
      data: Buffer.from(raw, "base64url"),
      mimeType: "message/rfc822",
    };
  }

  async messagesSince(since: string, folder?: string, maxResults: number = 50): Promise<EmailSummary[]> {
    const epoch = Math.floor(new Date(since).getTime() / 1000);
    if (!Number.isFinite(epoch)) throw new Error(`Invalid since timestamp: ${since}`);
    const labelPart = folder ? ` label:${folder}` : "";
    return this.searchMessages(`after:${epoch}${labelPart}`, maxResults);
  }

  get gmailApi() { return this.gmail; }
}
