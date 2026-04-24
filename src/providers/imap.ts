import type { ImapFlow } from "imapflow";
import type { Transporter } from "nodemailer";
import { stripCRLF } from "../security/validation.js";
import { buildRawMimeMessage } from "./mime.js";
import { ensureReplyPrefix, ensureForwardPrefix } from "./headers.js";
import type {
  MailProvider, ProviderCapabilities, EmailSummary, EmailMessage,
  EmailThread, Label, SendOptions, ReplyOptions, ForwardOptions,
  DraftOptions, AttachmentInfo, Attachment, DraftSummary, UnreadCount, ExportedMessage,
} from "./interface.js";

function formatAddress(addr: { address?: string; name?: string } | undefined): string {
  if (!addr) return "";
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address ?? "";
}

function formatAddresses(addrs: Array<{ address?: string; name?: string }> | undefined): string[] {
  return (addrs ?? []).map(formatAddress).filter(Boolean);
}

/**
 * IMAP message IDs are scoped to a folder. We encode them as `folder:uid` so
 * downstream tools can move/read messages from the right mailbox. Bare UIDs
 * are accepted for backwards compatibility and assumed to live in INBOX.
 */
interface ImapMessageId {
  folder: string;
  uid: number;
}

function parseImapMessageId(raw: string): ImapMessageId {
  const idx = raw.lastIndexOf(":");
  if (idx > 0) {
    const folder = raw.slice(0, idx);
    const uid = parseInt(raw.slice(idx + 1), 10);
    if (!Number.isNaN(uid)) return { folder, uid };
  }
  const uid = parseInt(raw, 10);
  if (Number.isNaN(uid)) {
    throw new Error(`Invalid IMAP message id: "${raw}"`);
  }
  return { folder: "INBOX", uid };
}

/** RFC 3501 system flags — case-insensitive. */
const IMAP_SYSTEM_FLAGS = new Set(
  ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft", "\\Recent"].map(f => f.toLowerCase())
);

function assertFlagName(name: string): string {
  const normalized = name.startsWith("\\") ? name : `\\${name}`;
  if (!IMAP_SYSTEM_FLAGS.has(normalized.toLowerCase())) {
    throw new Error(
      `IMAP accounts use flags, not labels. "${name}" is not a recognized IMAP flag. Valid flags: Seen, Answered, Flagged, Deleted, Draft.`
    );
  }
  return normalized;
}

/** Locate a body-structure node by its IMAP part path. */
function findBodyNode(bodyStructure: any, partPath: string): any | undefined {
  if (!bodyStructure) return undefined;
  if (bodyStructure.part === partPath) return bodyStructure;
  for (const child of bodyStructure.childNodes ?? []) {
    const hit = findBodyNode(child, partPath);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Walk a bodyStructure and return the part path of the most readable text part.
 * Prefer text/plain, fall back to text/html, skip anything marked as attachment.
 */
function findReadableTextPart(bodyStructure: any): string | undefined {
  if (!bodyStructure) return undefined;
  const plain = findTextPart(bodyStructure, "text/plain");
  if (plain) return plain;
  return findTextPart(bodyStructure, "text/html");
}

function findTextPart(node: any, target: string): string | undefined {
  if (!node) return undefined;
  const mime = node.type && node.subtype ? `${node.type}/${node.subtype}`.toLowerCase() : "";
  if (mime === target && node.disposition !== "attachment" && node.part) {
    return node.part;
  }
  for (const child of node.childNodes ?? []) {
    const hit = findTextPart(child, target);
    if (hit) return hit;
  }
  return undefined;
}

/** Collect a readable stream into a UTF-8 string. */
async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Collect a readable stream into a Buffer. */
async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export class ImapProvider implements MailProvider {
  readonly type = "imap";
  readonly capabilities: ProviderCapabilities = {
    threads: false, filters: false, templates: false,
    signatures: false, vacation: false, unsubscribe: false,
    attachments: true, inboxSummary: true,
  };

  private specialFolderCache: Map<string, string> = new Map();

  constructor(
    private imap: ImapFlow,
    private smtp: Transporter,
    private email: string
  ) {}

  private async findSpecialFolder(specialUse: string): Promise<string> {
    if (this.specialFolderCache.has(specialUse)) {
      return this.specialFolderCache.get(specialUse)!;
    }
    const folders = await this.imap.list();
    const match = folders.find((f: any) => f.specialUse === specialUse);
    // Fall back to the bare name without the backslash prefix (e.g. "Drafts", "Trash")
    const resolved = match?.path ?? specialUse.replace("\\", "");
    this.specialFolderCache.set(specialUse, resolved);
    return resolved;
  }

  async searchMessages(query: string, maxResults: number = 20, folder: string = "INBOX"): Promise<EmailSummary[]> {
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const trimmed = query.trim();
      const isWildcard = trimmed === "" || trimmed === "*";
      const uids = isWildcard
        ? await this.listRecentUids(maxResults)
        : await this.searchByText(trimmed, maxResults);
      if (uids.length === 0) return [];

      const messages = await this.imap.fetchAll(uids, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      });

      return messages.map((msg: any) => ({
        id: `${folder}:${msg.uid}`,
        from: formatAddress(msg.envelope?.from?.[0]),
        to: formatAddresses(msg.envelope?.to),
        subject: msg.envelope?.subject ?? "",
        snippet: "",
        date: msg.envelope?.date?.toISOString() ?? "",
        labels: [],
        hasAttachments: (msg.bodyStructure?.childNodes?.length ?? 0) > 0,
      }));
    } finally {
      lock.release();
    }
  }

  async findMessageIds(query: string, folder?: string, maxResults?: number): Promise<string[]> {
    const messages = await this.searchMessages(query, maxResults ?? 1000, folder);
    return messages.map((m) => m.id);
  }

  private async searchByText(query: string, maxResults: number): Promise<number[]> {
    const searchResult = await this.imap.search({ or: [{ subject: query }, { body: query }] });
    const uids = searchResult || [];
    return uids.slice(-maxResults).reverse();
  }

  /** Fetch the N most recent UIDs from the currently locked mailbox. */
  private async listRecentUids(maxResults: number): Promise<number[]> {
    const status = (this.imap as any).mailbox;
    const total = status?.exists ?? 0;
    if (total === 0) return [];
    const startSeq = Math.max(1, total - maxResults + 1);
    const uids: number[] = [];
    for await (const msg of this.imap.fetch(`${startSeq}:*`, { uid: true })) {
      uids.push(msg.uid);
    }
    return uids.sort((a, b) => b - a);
  }

  async readMessage(messageId: string): Promise<EmailMessage> {
    return this.fetchMessage(messageId);
  }

  private async fetchMessage(messageId: string): Promise<EmailMessage> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const meta = await this.imap.fetchOne(uid, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      });
      if (!meta) throw new Error(`Message ${messageId} not found`);

      const textPart = findReadableTextPart(meta.bodyStructure);
      let body = "";
      if (textPart) {
        // download() decodes transfer-encoding (base64/quoted-printable) and
        // converts non-UTF-8 charsets to UTF-8 for text parts.
        const dl = await this.imap.download(uid, textPart, { uid: true });
        if (dl?.content) body = await readStreamToString(dl.content);
      } else if (!meta.bodyStructure?.childNodes) {
        // Single-part message with no explicit part path.
        const dl = await this.imap.download(uid, "TEXT", { uid: true });
        if (dl?.content) body = await readStreamToString(dl.content);
      }

      return {
        id: `${folder}:${uid}`,
        from: formatAddress(meta.envelope?.from?.[0]),
        to: formatAddresses(meta.envelope?.to),
        cc: formatAddresses(meta.envelope?.cc),
        bcc: [],
        replyTo: formatAddress(meta.envelope?.replyTo?.[0]) || undefined,
        subject: meta.envelope?.subject ?? "",
        snippet: body.slice(0, 100),
        date: meta.envelope?.date?.toISOString() ?? "",
        labels: [],
        hasAttachments: (meta.bodyStructure?.childNodes?.length ?? 0) > 0,
        body,
        attachments: extractImapAttachments(meta.bodyStructure),
      };
    } finally {
      lock.release();
    }
  }

  async readThread(threadId: string): Promise<EmailThread> {
    const message = await this.readMessage(threadId);
    return { id: threadId, subject: message.subject, messages: [message] };
  }

  async sendMessage(to: string[], subject: string, body: string, options?: SendOptions): Promise<string> {
    const result = await this.smtp.sendMail({
      from: this.email,
      to: stripCRLF(to.join(", ")),
      cc: options?.cc ? stripCRLF(options.cc.join(", ")) : undefined,
      bcc: options?.bcc ? stripCRLF(options.bcc.join(", ")) : undefined,
      subject: stripCRLF(subject),
      [options?.html ? "html" : "text"]: body,
      attachments: toNodemailerAttachments(options?.attachments),
    });
    return result.messageId ?? "";
  }

  async replyToMessage(messageId: string, body: string, options?: ReplyOptions): Promise<string> {
    const original = await this.fetchMessage(messageId);
    const replyAddress = original.replyTo || original.from;
    const to = [replyAddress];
    if (options?.replyAll) { to.push(...original.to, ...original.cc); }
    const subject = ensureReplyPrefix(original.subject);
    return this.sendMessage(to, subject, body, { html: options?.html, attachments: options?.attachments });
  }

  async forwardMessage(messageId: string, to: string[], options?: ForwardOptions): Promise<string> {
    const original = await this.fetchMessage(messageId);
    const fwdBody = options?.message
      ? `${options.message}\n\n---------- Forwarded message ----------\n${original.body}`
      : `---------- Forwarded message ----------\n${original.body}`;
    const subject = ensureForwardPrefix(original.subject);
    return this.sendMessage(to, subject, fwdBody, { html: options?.html, attachments: options?.attachments });
  }

  async createDraft(to: string[], subject: string, body: string, options?: DraftOptions): Promise<string> {
    const raw = buildRawMimeMessage({
      from: this.email,
      to, subject, body,
      cc: options?.cc, bcc: options?.bcc,
      html: options?.html,
      attachments: options?.attachments,
    });

    const draftsFolder = await this.findSpecialFolder("\\Drafts");
    const lock = await this.imap.getMailboxLock(draftsFolder);
    try {
      await this.imap.append(draftsFolder, raw, ["\\Draft"]);
      return `draft-${Date.now()}`;
    } finally {
      lock.release();
    }
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    const trashFolder = await this.findSpecialFolder("\\Trash");
    // Group by source folder so each mailbox is opened once.
    const byFolder = new Map<string, number[]>();
    for (const raw of messageIds) {
      const { folder, uid } = parseImapMessageId(raw);
      const list = byFolder.get(folder) ?? [];
      list.push(uid);
      byFolder.set(folder, list);
    }
    for (const [folder, uids] of byFolder) {
      const lock = await this.imap.getMailboxLock(folder);
      try {
        for (const uid of uids) {
          await this.imap.messageMove(uid, trashFolder);
        }
      } finally {
        lock.release();
      }
    }
  }

  async listLabels(): Promise<Label[]> {
    const folders = await this.imap.list();
    return folders.map((f: any) => ({
      id: f.path, name: f.path,
      type: f.specialUse ? ("system" as const) : ("user" as const),
    }));
  }

  async createLabel(name: string): Promise<Label> {
    await this.imap.mailboxCreate(name);
    return { id: name, name, type: "user" };
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.imap.mailboxDelete(labelId);
  }

  async modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void> {
    const { folder, uid } = parseImapMessageId(messageId);
    const addFlags = add.map(assertFlagName);
    const removeFlags = remove.map(assertFlagName);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      if (addFlags.length) await this.imap.messageFlagsAdd(uid, addFlags);
      if (removeFlags.length) await this.imap.messageFlagsRemove(uid, removeFlags);
    } finally {
      lock.release();
    }
  }

  async batchModifyLabels(messageIds: string[], add: string[], remove: string[]): Promise<void> {
    for (const id of messageIds) {
      await this.modifyLabels(id, add, remove);
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<{ filename: string; data: Buffer; mimeType: string }> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const meta = await this.imap.fetchOne(uid, { bodyStructure: true, uid: true });
      if (!meta) throw new Error(`Message ${messageId} not found`);
      const node = findBodyNode(meta.bodyStructure, attachmentId);
      if (!node) throw new Error(`Attachment ${attachmentId} not found`);

      const dl = await this.imap.download(uid, attachmentId, { uid: true });
      if (!dl?.content) throw new Error(`Attachment ${attachmentId} could not be downloaded`);
      const data = await readStreamToBuffer(dl.content);

      const filename = dl.meta?.filename
        ?? node.parameters?.name
        ?? node.dispositionParameters?.filename
        ?? `attachment-${attachmentId}`;
      const mimeType = dl.meta?.contentType
        ?? (node.type && node.subtype ? `${node.type}/${node.subtype}` : "application/octet-stream");
      return { filename, data, mimeType };
    } finally {
      lock.release();
    }
  }

  async inboxSummary(): Promise<{ total: number; unread: number; recent: EmailSummary[] }> {
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      const status = (this.imap as any).mailbox;
      const total = status?.exists ?? 0;
      const unread = status?.unseen ?? 0;
      const uids = await this.listRecentUids(5);
      if (uids.length === 0) return { total, unread, recent: [] };

      const messages = await this.imap.fetchAll(uids, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      });
      const recent: EmailSummary[] = messages.map((msg: any) => ({
        id: `INBOX:${msg.uid}`,
        from: formatAddress(msg.envelope?.from?.[0]),
        to: formatAddresses(msg.envelope?.to),
        subject: msg.envelope?.subject ?? "",
        snippet: "",
        date: msg.envelope?.date?.toISOString() ?? "",
        labels: [],
        hasAttachments: (msg.bodyStructure?.childNodes?.length ?? 0) > 0,
      }));
      return { total, unread, recent };
    } finally {
      lock.release();
    }
  }

  async markRead(messageId: string, read: boolean): Promise<void> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      if (read) await this.imap.messageFlagsAdd(uid, ["\\Seen"]);
      else await this.imap.messageFlagsRemove(uid, ["\\Seen"]);
    } finally {
      lock.release();
    }
  }

  async starMessage(messageId: string, starred: boolean): Promise<void> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      if (starred) await this.imap.messageFlagsAdd(uid, ["\\Flagged"]);
      else await this.imap.messageFlagsRemove(uid, ["\\Flagged"]);
    } finally {
      lock.release();
    }
  }

  async archiveMessage(messageId: string): Promise<void> {
    const { folder, uid } = parseImapMessageId(messageId);
    const archive = await this.findSpecialFolder("\\Archive");
    const lock = await this.imap.getMailboxLock(folder);
    try {
      await this.imap.messageMove(uid, archive);
    } finally {
      lock.release();
    }
  }

  async listDrafts(maxResults: number = 20): Promise<DraftSummary[]> {
    const drafts = await this.findSpecialFolder("\\Drafts");
    const lock = await this.imap.getMailboxLock(drafts);
    try {
      const uids = await this.listRecentUids(maxResults);
      if (uids.length === 0) return [];
      const messages = await this.imap.fetchAll(uids, {
        envelope: true, uid: true, internalDate: true,
      });
      return messages.map((msg: any) => ({
        id: `${drafts}:${msg.uid}`,
        subject: msg.envelope?.subject ?? "",
        to: formatAddresses(msg.envelope?.to),
        snippet: "",
        updatedAt: (msg.internalDate ?? msg.envelope?.date)?.toISOString?.() ?? "",
      }));
    } finally {
      lock.release();
    }
  }

  async sendDraft(draftId: string): Promise<string> {
    const { folder, uid } = parseImapMessageId(draftId);
    const lock = await this.imap.getMailboxLock(folder);
    let rawSource: Buffer;
    let envelope: any;
    try {
      const msg: any = await this.imap.fetchOne(uid, { source: true, envelope: true, uid: true });
      if (!msg || !msg.source) throw new Error(`Draft ${draftId} not found`);
      rawSource = msg.source;
      envelope = msg.envelope;
    } finally {
      lock.release();
    }

    const to = formatAddresses(envelope?.to);
    const cc = formatAddresses(envelope?.cc);
    const bcc = formatAddresses(envelope?.bcc);
    const result = await this.smtp.sendMail({
      from: stripCRLF(this.email),
      to: stripCRLF(to.join(", ")),
      cc: cc.length ? stripCRLF(cc.join(", ")) : undefined,
      bcc: bcc.length ? stripCRLF(bcc.join(", ")) : undefined,
      raw: rawSource,
    });

    // Remove sent draft from Drafts folder
    const cleanupLock = await this.imap.getMailboxLock(folder);
    try {
      await this.imap.messageDelete(uid, { uid: true });
    } finally {
      cleanupLock.release();
    }

    return result.messageId ?? "";
  }

  async countUnreadByLabel(): Promise<UnreadCount[]> {
    const folders = await this.imap.list();
    const counts: UnreadCount[] = [];
    for (const f of folders as any[]) {
      if (f.flags?.has?.("\\Noselect")) continue;
      try {
        const status = await (this.imap as any).status(f.path, { unseen: true });
        const unseen = status?.unseen ?? 0;
        if (unseen > 0) counts.push({ labelId: f.path, name: f.path, unread: unseen });
      } catch {
        // skip folders we can't STATUS
      }
    }
    return counts.sort((a, b) => b.unread - a.unread);
  }

  async exportMessage(messageId: string): Promise<ExportedMessage> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const msg: any = await this.imap.fetchOne(uid, { source: true, uid: true });
      if (!msg || !msg.source) throw new Error(`Message ${messageId} not found`);
      return {
        filename: `${uid}.eml`,
        data: msg.source,
        mimeType: "message/rfc822",
      };
    } finally {
      lock.release();
    }
  }

  async messagesSince(since: string, folder: string = "INBOX", maxResults: number = 50): Promise<EmailSummary[]> {
    const date = new Date(since);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid since timestamp: ${since}`);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const uids = (await this.imap.search({ since: date })) || [];
      const limited = uids.slice(-maxResults).reverse();
      if (limited.length === 0) return [];
      const messages = await this.imap.fetchAll(limited, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      });
      return messages.map((msg: any) => ({
        id: `${folder}:${msg.uid}`,
        from: formatAddress(msg.envelope?.from?.[0]),
        to: formatAddresses(msg.envelope?.to),
        subject: msg.envelope?.subject ?? "",
        snippet: "",
        date: msg.envelope?.date?.toISOString() ?? "",
        labels: [],
        hasAttachments: (msg.bodyStructure?.childNodes?.length ?? 0) > 0,
      }));
    } finally {
      lock.release();
    }
  }
}

function toNodemailerAttachments(atts: Attachment[] | undefined) {
  if (!atts || atts.length === 0) return undefined;
  return atts.map((a) => ({
    filename: a.filename,
    content: a.data,
    contentType: a.mimeType,
  }));
}

function extractImapAttachments(bodyStructure: any): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  if (!bodyStructure?.childNodes) return attachments;
  for (const node of bodyStructure.childNodes) {
    if (node.disposition === "attachment" && node.parameters?.name) {
      attachments.push({
        id: node.part ?? "", filename: node.parameters.name,
        mimeType: `${node.type}/${node.subtype}`, size: node.size ?? 0,
      });
    }
    if (node.childNodes) { attachments.push(...extractImapAttachments(node)); }
  }
  return attachments;
}
