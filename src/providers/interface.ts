export interface EmailSummary {
  id: string;
  threadId?: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  hasAttachments: boolean;
}

export interface EmailMessage extends EmailSummary {
  body: string;
  cc: string[];
  bcc: string[];
  replyTo?: string;
  attachments: AttachmentInfo[];
}

export interface EmailThread {
  id: string;
  subject: string;
  messages: EmailMessage[];
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface DraftSummary {
  id: string;
  messageId?: string;
  subject: string;
  to: string[];
  snippet: string;
  updatedAt: string;
}

export interface UnreadCount {
  labelId: string;
  name: string;
  unread: number;
}

export interface ExportedMessage {
  filename: string;
  data: Buffer;
  mimeType: string;
}

/** Resolved outbound attachment, ready to hand to a provider. */
export interface Attachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface Label {
  id: string;
  name: string;
  type: "system" | "user";
}

export interface SendOptions {
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface ReplyOptions {
  replyAll?: boolean;
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  attachments?: Attachment[];
}

export interface ForwardOptions {
  message?: string;
  html?: boolean;
  attachments?: Attachment[];
}

export interface DraftOptions {
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  inReplyTo?: string;
  attachments?: Attachment[];
}

export interface ProviderCapabilities {
  threads: boolean;
  filters: boolean;
  templates: boolean;
  signatures: boolean;
  vacation: boolean;
  unsubscribe: boolean;
  attachments: boolean;
  inboxSummary: boolean;
}

export interface MailProvider {
  readonly type: string;
  readonly capabilities: ProviderCapabilities;

  searchMessages(query: string, maxResults?: number, folder?: string): Promise<EmailSummary[]>;
  findMessageIds(query: string, folder?: string, maxResults?: number): Promise<string[]>;
  readMessage(messageId: string): Promise<EmailMessage>;
  readThread(threadId: string): Promise<EmailThread>;
  sendMessage(to: string[], subject: string, body: string, options?: SendOptions): Promise<string>;
  replyToMessage(messageId: string, body: string, options?: ReplyOptions): Promise<string>;
  forwardMessage(messageId: string, to: string[], options?: ForwardOptions): Promise<string>;
  createDraft(to: string[], subject: string, body: string, options?: DraftOptions): Promise<string>;
  trashMessages(messageIds: string[]): Promise<void>;

  listLabels(): Promise<Label[]>;
  createLabel(name: string): Promise<Label>;
  deleteLabel(labelId: string): Promise<void>;
  modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void>;
  batchModifyLabels(messageIds: string[], add: string[], remove: string[]): Promise<void>;

  downloadAttachment(messageId: string, attachmentId: string): Promise<{ filename: string; data: Buffer; mimeType: string }>;
  inboxSummary(): Promise<{ total: number; unread: number; recent: EmailSummary[] }>;

  markRead(messageId: string, read: boolean): Promise<void>;
  starMessage(messageId: string, starred: boolean): Promise<void>;
  archiveMessage(messageId: string): Promise<void>;
  listDrafts(maxResults?: number): Promise<DraftSummary[]>;
  sendDraft(draftId: string): Promise<string>;
  countUnreadByLabel(): Promise<UnreadCount[]>;
  exportMessage(messageId: string): Promise<ExportedMessage>;
  messagesSince(since: string, folder?: string, maxResults?: number): Promise<EmailSummary[]>;
}
