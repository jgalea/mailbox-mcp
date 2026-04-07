import type { ImapFlow } from "imapflow";
import type { Transporter } from "nodemailer";
import { fenceEmailContent } from "../security/sanitize.js";
import { stripCRLF } from "../security/validation.js";
import type {
  MailProvider, ProviderCapabilities, EmailSummary, EmailMessage,
  EmailThread, Label, SendOptions, ReplyOptions, ForwardOptions,
  DraftOptions, AttachmentInfo,
} from "./interface.js";

function formatAddress(addr: { address?: string; name?: string } | undefined): string {
  if (!addr) return "";
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address ?? "";
}

function formatAddresses(addrs: Array<{ address?: string; name?: string }> | undefined): string[] {
  return (addrs ?? []).map(formatAddress).filter(Boolean);
}

export class ImapProvider implements MailProvider {
  readonly type = "imap";
  readonly capabilities: ProviderCapabilities = {
    threads: false, filters: false, snooze: false, templates: false,
    signatures: false, vacation: false, contacts: false, unsubscribe: false,
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

  async searchMessages(query: string, maxResults: number = 20): Promise<EmailSummary[]> {
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      const searchResult = await this.imap.search({ or: [{ subject: query }, { body: query }] });
      const uids = searchResult || [];
      const limited = uids.slice(-maxResults).reverse();
      if (limited.length === 0) return [];

      const messages = await this.imap.fetchAll(limited, {
        envelope: true, flags: true, bodyStructure: true, uid: true,
      });

      return messages.map((msg: any) => ({
        id: String(msg.uid),
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

  async readMessage(messageId: string): Promise<EmailMessage> {
    return this.fetchMessage(messageId, true);
  }

  /** Fetch message with optional fencing. Unfenced variant used for forward/reply outgoing content. */
  private async fetchMessage(messageId: string, fence: boolean): Promise<EmailMessage> {
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      const fetchResult = await this.imap.fetchOne(parseInt(messageId), {
        envelope: true, source: true, flags: true, bodyStructure: true, uid: true,
      });
      if (!fetchResult) throw new Error(`Message ${messageId} not found`);
      const msg = fetchResult;

      const body = msg.source?.toString("utf-8") ?? "";
      const plainBody = extractPlainBody(body);
      const subject = msg.envelope?.subject ?? "";

      return {
        id: messageId,
        from: formatAddress(msg.envelope?.from?.[0]),
        to: formatAddresses(msg.envelope?.to),
        cc: formatAddresses(msg.envelope?.cc),
        bcc: [],
        replyTo: formatAddress(msg.envelope?.replyTo?.[0]) || undefined,
        subject: fence ? fenceEmailContent(subject, "subject") : subject,
        snippet: plainBody.slice(0, 100),
        date: msg.envelope?.date?.toISOString() ?? "",
        labels: [],
        hasAttachments: (msg.bodyStructure?.childNodes?.length ?? 0) > 0,
        body: fence ? fenceEmailContent(plainBody) : plainBody,
        attachments: extractImapAttachments(msg.bodyStructure),
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
    });
    return result.messageId ?? "";
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
    const raw = [
      `From: ${this.email}`,
      `To: ${stripCRLF(to.join(", "))}`,
      `Subject: ${stripCRLF(subject)}`,
      options?.cc ? `Cc: ${stripCRLF(options.cc.join(", "))}` : "",
      `MIME-Version: 1.0`,
      `Content-Type: text/${options?.html ? "html" : "plain"}; charset=utf-8`,
      "", body,
    ].filter(Boolean).join("\r\n");

    const draftsFolder = await this.findSpecialFolder("\\Drafts");
    const lock = await this.imap.getMailboxLock(draftsFolder);
    try {
      await this.imap.append(draftsFolder, Buffer.from(raw), ["\\Draft"]);
      return `draft-${Date.now()}`;
    } finally {
      lock.release();
    }
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    const trashFolder = await this.findSpecialFolder("\\Trash");
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      for (const id of messageIds) {
        await this.imap.messageMove(parseInt(id), trashFolder);
      }
    } finally {
      lock.release();
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
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      if (add.length) await this.imap.messageFlagsAdd(parseInt(messageId), add);
      if (remove.length) await this.imap.messageFlagsRemove(parseInt(messageId), remove);
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
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      const fetchResult = await this.imap.fetchOne(parseInt(messageId), { bodyParts: [attachmentId], uid: true });
      if (!fetchResult) throw new Error(`Message ${messageId} not found`);
      const part = fetchResult.bodyParts?.get(attachmentId);
      if (!part) throw new Error(`Attachment ${attachmentId} not found`);
      return { filename: attachmentId, data: Buffer.from(part), mimeType: "application/octet-stream" };
    } finally {
      lock.release();
    }
  }

  async inboxSummary(): Promise<{ total: number; unread: number; recent: EmailSummary[] }> {
    const lock = await this.imap.getMailboxLock("INBOX");
    try {
      const status = (this.imap as any).mailbox;
      const recent = await this.searchMessages("*", 5);
      return { total: status?.exists ?? 0, unread: status?.unseen ?? 0, recent };
    } finally {
      lock.release();
    }
  }
}

function extractPlainBody(source: string): string {
  const boundaryMatch = source.match(/boundary="?([^"\s;]+)"?/);
  if (!boundaryMatch) {
    const idx = source.indexOf("\r\n\r\n");
    return idx >= 0 ? source.slice(idx + 4) : source;
  }
  const boundary = boundaryMatch[1];
  const parts = source.split(`--${boundary}`);
  for (const part of parts) {
    if (part.includes("text/plain")) {
      const bodyStart = part.indexOf("\r\n\r\n");
      if (bodyStart >= 0) return part.slice(bodyStart + 4).trim();
    }
  }
  const idx = source.indexOf("\r\n\r\n");
  return idx >= 0 ? source.slice(idx + 4) : source;
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
