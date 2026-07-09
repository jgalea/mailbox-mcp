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

/**
 * Canonical RFC 3501 system flags. Servers treat flag names case-insensitively
 * but we emit title case for readability and consistency.
 */
const IMAP_SYSTEM_FLAGS: Record<string, string> = {
  seen: "\\Seen",
  answered: "\\Answered",
  flagged: "\\Flagged",
  deleted: "\\Deleted",
  draft: "\\Draft",
  recent: "\\Recent",
};

/**
 * Cross-provider label vocabulary used by Gmail (`UNREAD`, `STARRED`, etc.)
 * needs to map onto IMAP flags so `modify_email` works the same way across
 * providers. `UNREAD` is the logical inverse of `\Seen` — adding UNREAD means
 * *removing* \Seen and vice versa — so callers of `resolveImapFlags` must
 * cross inverted entries to the opposite operation.
 */
interface ResolvedFlag {
  flag: string;
  /** When true, the caller should apply this flag to the opposite operation. */
  invert: boolean;
}

function resolveImapFlag(name: string): ResolvedFlag {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Empty flag name");
  }

  // UNREAD is the inverse of \Seen — see RFC 3501 §2.3.2.
  if (trimmed.toLowerCase() === "unread") {
    return { flag: "\\Seen", invert: true };
  }
  // STARRED is Gmail's vocabulary for what IMAP calls \Flagged. Mapping here
  // keeps cross-provider callers (markRead/starMessage on a generic provider)
  // working against IMAP without changing their inputs.
  if (trimmed.toLowerCase() === "starred") {
    return { flag: "\\Flagged", invert: false };
  }

  // Strip a leading \ so callers can pass either "Seen" or "\Seen".
  const bare = trimmed.startsWith("\\") ? trimmed.slice(1) : trimmed;
  const canonical = IMAP_SYSTEM_FLAGS[bare.toLowerCase()];
  if (canonical) {
    return { flag: canonical, invert: false };
  }

  // Unknown names pass through as IMAP keywords. RFC 3501 §2.3.2 explicitly
  // permits server-defined and user-defined keywords alongside system flags,
  // and imapflow forwards them to the server. This is a deliberate change
  // from the previous behaviour (throw on anything not in the system-flag
  // set) — it makes the IMAP provider useful for workflows that depend on
  // custom keywords (e.g. `$Junk`, `NonJunk`, project-specific tags).
  return { flag: trimmed, invert: false };
}

/**
 * Resolve `add` and `remove` arrays into the actual `addFlags` / `removeFlags`
 * lists to send to imapflow, with inverted entries (UNREAD) crossed to the
 * opposite operation.
 */
function resolveImapFlags(add: string[], remove: string[]): { addFlags: string[]; removeFlags: string[] } {
  const addFlags: string[] = [];
  const removeFlags: string[] = [];
  for (const name of add) {
    const r = resolveImapFlag(name);
    (r.invert ? removeFlags : addFlags).push(r.flag);
  }
  for (const name of remove) {
    const r = resolveImapFlag(name);
    (r.invert ? addFlags : removeFlags).push(r.flag);
  }
  return { addFlags, removeFlags };
}

/**
 * Resolve the MIME type of an imapflow bodyStructure node.
 *
 * imapflow stores the full Content-Type in `node.type` (e.g. "text/plain",
 * "multipart/alternative") and does not populate a separate `node.subtype` field.
 * The defensive `node.subtype` fallback covers test fixtures and any hypothetical
 * future shape change.
 */
function nodeMimeType(node: any): string {
  if (!node) return "";
  if (node.subtype) return `${node.type}/${node.subtype}`.toLowerCase();
  return (node.type ?? "").toLowerCase();
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

/** Filename advertised by an attachment node, if any. */
function attachmentFilename(node: any): string | undefined {
  return node?.dispositionParameters?.filename ?? node?.parameters?.name;
}

/** Flatten a bodyStructure into the leaf nodes that look like attachments. */
function collectAttachmentNodes(node: any, out: any[] = []): any[] {
  if (!node) return out;
  const isAttachment =
    node.disposition === "attachment" ||
    (node.part && attachmentFilename(node) && !nodeMimeType(node).startsWith("multipart/"));
  if (isAttachment && node.part) out.push(node);
  for (const child of node.childNodes ?? []) collectAttachmentNodes(child, out);
  return out;
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
  if (nodeMimeType(node) === target && node.disposition !== "attachment" && node.part) {
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
      }, { uid: true });

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
    // imapflow's search() returns sequence numbers without { uid: true }.
    // Without this, the downstream fetchAll treats the seq nums as UIDs and
    // either fetches the wrong rows or returns empty results on a mailbox
    // with expunged messages.
    const searchResult = await this.imap.search(
      { or: [{ subject: query }, { body: query }] },
      { uid: true },
    );
    let uids = searchResult || [];

    // Non-ASCII queries (Cyrillic, CJK, etc.) frequently return empty from IMAP
    // SEARCH even though imapflow sends CHARSET UTF-8: many servers match against
    // the raw RFC 2047-encoded Subject header (=?utf-8?B?...?=) rather than the
    // decoded text, and body search is often unindexed. Fall back to a bounded
    // client-side envelope scan so users aren't told their messages don't exist.
    if (uids.length === 0 && /[^\x00-\x7F]/.test(query)) {
      uids = await this.clientSideEnvelopeSearch(query, maxResults);
    }
    return uids.slice(-maxResults).reverse();
  }

  /**
   * Scan the tail of the open mailbox and match the query against the decoded
   * envelope (subject, from address, from name). Capped to avoid runaway scans
   * on large mailboxes. Returns UIDs to match the searchByText contract.
   */
  private async clientSideEnvelopeSearch(query: string, maxResults: number): Promise<number[]> {
    const status = (this.imap as any).mailbox;
    const total = status?.exists ?? 0;
    if (total === 0) return [];
    const SCAN_LIMIT = 1000;
    const startSeq = Math.max(1, total - SCAN_LIMIT + 1);
    const needle = query.toLowerCase();
    const matches: number[] = [];
    for await (const msg of this.imap.fetch(`${startSeq}:*`, { uid: true, envelope: true })) {
      const subject = (msg.envelope?.subject ?? "").toLowerCase();
      const from = msg.envelope?.from?.[0];
      const fromText = `${from?.name ?? ""} ${from?.address ?? ""}`.toLowerCase();
      if (subject.includes(needle) || fromText.includes(needle)) {
        matches.push(msg.uid);
        if (matches.length >= maxResults) break;
      }
    }
    return matches;
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
      }, { uid: true });
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
    // No alias list to check against on plain IMAP/SMTP — the relay is the
    // authority on which senders it will accept, and it rejects at send time.
    const result = await this.smtp.sendMail({
      from: options?.from ? stripCRLF(options.from) : this.email,
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
    return this.sendMessage(to, subject, body, { from: options?.from, cc: options?.cc, bcc: options?.bcc, html: options?.html, attachments: options?.attachments });
  }

  async forwardMessage(messageId: string, to: string[], options?: ForwardOptions): Promise<string> {
    const original = await this.fetchMessage(messageId);
    const fwdBody = options?.message
      ? `${options.message}\n\n---------- Forwarded message ----------\n${original.body}`
      : `---------- Forwarded message ----------\n${original.body}`;
    const subject = ensureForwardPrefix(original.subject);
    return this.sendMessage(to, subject, fwdBody, { from: options?.from, html: options?.html, attachments: options?.attachments });
  }

  async createDraft(to: string[], subject: string, body: string, options?: DraftOptions): Promise<string> {
    const raw = buildRawMimeMessage({
      from: options?.from ?? this.email,
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
          await this.imap.messageMove(uid, trashFolder, { uid: true });
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
    const { addFlags, removeFlags } = resolveImapFlags(add, remove);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      if (addFlags.length) await this.imap.messageFlagsAdd(uid, addFlags, { uid: true });
      if (removeFlags.length) await this.imap.messageFlagsRemove(uid, removeFlags, { uid: true });
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
      const meta = await this.imap.fetchOne(uid, { bodyStructure: true, uid: true }, { uid: true });
      if (!meta) throw new Error(`Message ${messageId} not found`);

      // Accept either the IMAP part path (e.g. "2") or the attachment filename.
      // read_email renders both — users naturally reach for the filename, which
      // historically failed because findBodyNode only matched on part path.
      const candidates = collectAttachmentNodes(meta.bodyStructure);
      const node =
        findBodyNode(meta.bodyStructure, attachmentId) ??
        candidates.find((n) => attachmentFilename(n) === attachmentId);
      if (!node) {
        const available = candidates
          .map((n) => attachmentFilename(n) ?? n.part)
          .filter(Boolean)
          .join(", ") || "(none)";
        throw new Error(`Attachment "${attachmentId}" not found. Available: ${available}`);
      }

      const partPath = node.part;
      const dl = await this.imap.download(uid, partPath, { uid: true });
      if (!dl?.content) throw new Error(`Attachment ${attachmentId} could not be downloaded`);
      const data = await readStreamToBuffer(dl.content);

      const filename = dl.meta?.filename
        ?? attachmentFilename(node)
        ?? `attachment-${partPath}`;
      const mimeType = dl.meta?.contentType
        ?? nodeMimeType(node)
        ?? "application/octet-stream";
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
      // mailbox.unseen is populated by imapflow at SELECT time and never
      // refreshed — marking messages read/unread, IDLE updates, and concurrent
      // changes from other clients don't touch it. Count fresh via SEARCH
      // against the locked mailbox instead. (Using SEARCH rather than STATUS
      // because RFC 3501 §6.3.10 says STATUS SHOULD NOT be used on the
      // currently-selected mailbox, and we're already inside a lock here.)
      const unseenUids = (await this.imap.search({ seen: false }, { uid: true })) || [];
      const unread = unseenUids.length;
      const uids = await this.listRecentUids(5);
      if (uids.length === 0) return { total, unread, recent: [] };

      const messages = await this.imap.fetchAll(uids, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      }, { uid: true });
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
      if (read) await this.imap.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      else await this.imap.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  }

  async starMessage(messageId: string, starred: boolean): Promise<void> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      if (starred) await this.imap.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
      else await this.imap.messageFlagsRemove(uid, ["\\Flagged"], { uid: true });
    } finally {
      lock.release();
    }
  }

  async archiveMessage(messageId: string): Promise<void> {
    const { folder, uid } = parseImapMessageId(messageId);
    const archive = await this.findSpecialFolder("\\Archive");
    const lock = await this.imap.getMailboxLock(folder);
    try {
      await this.imap.messageMove(uid, archive, { uid: true });
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
      }, { uid: true });
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
      const msg: any = await this.imap.fetchOne(uid, { source: true, envelope: true, uid: true }, { uid: true });
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
    const folders = ((await this.imap.list()) as any[])
      .filter((f) => !f.flags?.has?.("\\Noselect"));
    // Sequential STATUS round-trips on accounts with many folders pushed this past
    // MCP timeouts. IMAP servers tolerate small concurrency for STATUS commands.
    const CONCURRENCY = 8;
    const results: (UnreadCount | null)[] = new Array(folders.length).fill(null);
    let cursor = 0;
    const self = this;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= folders.length) return;
        const f = folders[i];
        try {
          const status = await (self.imap as any).status(f.path, { unseen: true });
          const unseen = status?.unseen ?? 0;
          if (unseen > 0) results[i] = { labelId: f.path, name: f.path, unread: unseen };
        } catch {
          // skip folders we can't STATUS
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, folders.length) }, () => worker()));
    return (results.filter(Boolean) as UnreadCount[]).sort((a, b) => b.unread - a.unread);
  }

  async exportMessage(messageId: string): Promise<ExportedMessage> {
    const { folder, uid } = parseImapMessageId(messageId);
    const lock = await this.imap.getMailboxLock(folder);
    try {
      const msg: any = await this.imap.fetchOne(uid, { source: true, uid: true }, { uid: true });
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
      // Same UID/seq mismatch as searchByText: search() returns seq nums by
      // default, fetchAll then treats them as UIDs. Pass { uid: true } at
      // both call sites so the pipeline is UID-based end to end.
      const uids = (await this.imap.search({ since: date }, { uid: true })) || [];
      const limited = uids.slice(-maxResults).reverse();
      if (limited.length === 0) return [];
      const messages = await this.imap.fetchAll(limited, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      }, { uid: true });
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
  return collectAttachmentNodes(bodyStructure).map((node) => ({
    id: node.part ?? "",
    filename: attachmentFilename(node) ?? "",
    mimeType: nodeMimeType(node) || "application/octet-stream",
    size: node.size ?? 0,
  }));
}
