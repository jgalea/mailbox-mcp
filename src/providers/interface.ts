/** What the provider can vouch for about a message's origin. Backs the untrusted-read lock. */
export interface SenderAuth {
  /** Authentication-Results header values, topmost (the receiving server's) first. */
  authenticationResults: string[];
  /** True when the account itself sent the message (Sent folder or SENT label). */
  sent: boolean;
}

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
  /** Absent when the provider could not say, which the lock treats as unauthenticated. */
  auth?: SenderAuth;
}

export interface EmailMessage extends EmailSummary {
  body: string;
  /** True when `body` is the HTML part (no text/plain part was available). */
  bodyIsHtml?: boolean;
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
  /**
   * Sender address. Must be an address the account is allowed to send as
   * (a Gmail send-as alias, a JMAP identity). Defaults to the account's
   * primary address.
   */
  from?: string;
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface ReplyOptions {
  from?: string;
  replyAll?: boolean;
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  attachments?: Attachment[];
}

export interface ForwardOptions {
  from?: string;
  message?: string;
  html?: boolean;
  attachments?: Attachment[];
}

export interface DraftOptions {
  from?: string;
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

  /** Whether any message on the account was sent to or received from `address`. Used by the new-recipient check. */
  hasCorrespondedWith?(address: string): Promise<boolean>;
  /** To/Cc/Bcc of an existing draft, so send_draft can run the recipient guards. */
  getDraftRecipients?(draftId: string): Promise<string[]>;
  /** Whether the account has ever sent a message to `address` (Sent folder only, received mail does not count). Used by the untrusted-read lock. */
  hasSentTo?(address: string): Promise<boolean>;
  /** A string that changes whenever the draft's content or recipients change, so a queued send_draft stays bound to what was reviewed. */
  draftFingerprint?(draftId: string): Promise<string>;
}
