import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { AccountManager, type AccountConfig } from "./accounts.js";
import { createProvider } from "./provider-factory.js";
import { loadAttachments } from "./security/attachment-loader.js";
import { checkOutgoing } from "./security/send-guard.js";
import { redactTokens, stripInvisibleChars } from "./security/sanitize.js";
import { recordSend } from "./sendlog.js";
import { extractAddress } from "./providers/headers.js";
import { allRecipients, isExpired, listPending, readPendingWithDigest, removePending, type PendingSend } from "./pending.js";
import type { Attachment, MailProvider } from "./providers/interface.js";

// The approve CLI is the other half of approval: "external". It is the only
// thing that can turn a pending file into a sent message, and it insists on a
// human at a terminal: the confirmation is read from /dev/tty, never stdin.

export interface Terminal {
  write(text: string): void;
  readLine(): string;
  close(): void;
}

export interface CliDeps {
  openTerminal?: () => Terminal;
  getProvider?: (alias: string, config: AccountConfig, configDir: string) => Promise<MailProvider>;
  print?: (line: string) => void;
  now?: () => number;
}

const USAGE = [
  "Usage:",
  "  mailbox-mcp                 start the MCP server on stdio",
  "  mailbox-mcp pending         list sends waiting for approval",
  "  mailbox-mcp show <id>       print one pending send in full",
  "  mailbox-mcp approve <id>    send it, after you confirm at the terminal",
  "  mailbox-mcp reject <id>     drop it without sending",
].join("\n");

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// A process with no controlling terminal, which is what an agent's shell is,
// cannot open /dev/tty. Piping "yes" into stdin does nothing here.
export function openTty(): Terminal {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new Error(`approve needs an interactive terminal and /dev/tty could not be opened (${code}). Run it yourself in a terminal; it is deliberately impossible from a non-interactive shell.`);
  }
  return {
    write: (text) => { writeSync(fd, text); },
    readLine: () => {
      const bytes: number[] = [];
      const byte = Buffer.alloc(1);
      while (readSync(fd, byte, 0, 1, null) === 1) {
        if (byte[0] === 0x0a) break;
        bytes.push(byte[0]);
      }
      return Buffer.from(bytes).toString("utf-8").replace(/\r$/, "");
    },
    close: () => { closeSync(fd); },
  };
}

// Terminal escapes, bidi overrides and zero-width characters can make the
// screen show something other than what will be sent. Such a message is never
// approved from here: the count is reported and the user rejects it.
export function hiddenCharacterCount(spec: PendingSend): number {
  const fields = [spec.from ?? "", ...spec.to, ...spec.cc, ...spec.bcc, spec.subject, spec.body, ...spec.attachments.flatMap((a) => [a.name, a.path])];
  return fields.reduce((n, f) => n + stripInvisibleChars(f).removed + (f.match(CONTROL_CHARS)?.length ?? 0), 0);
}

function display(text: string): string {
  return stripInvisibleChars(text).text.replace(CONTROL_CHARS, "?");
}

function describeAction(spec: PendingSend): string | null {
  switch (spec.action.kind) {
    case "reply":
      return `Reply to message ${spec.action.messageId}${spec.action.replyAll ? " (reply all; the provider fills Cc from the original)" : ""}.`;
    case "forward":
      return `Forward of message ${spec.action.messageId}; the provider appends the original below the note.`;
    case "sendDraft":
      return `Sends draft ${spec.action.draftId} exactly as it was when queued; approve refuses if the draft changed since. Open the draft in your mail client to review its body.`;
    default:
      return null;
  }
}

export function formatPending(spec: PendingSend, now: number = Date.now(), full = true): string {
  const lines = [
    `${spec.id}  ${spec.account}  ${spec.tool}  queued ${spec.createdAt}${isExpired(spec, now) ? "  EXPIRED" : ""}`,
    `  reason:      ${spec.reason === "untrusted-read" ? `untrusted-read lock (${display(spec.taintedBy ?? "")})` : "approval: external"}`,
    `  from:        ${spec.from ? display(spec.from) : "(account default)"}`,
    `  to:          ${display(spec.to.join(", "))}`,
  ];
  if (spec.cc.length) lines.push(`  cc:          ${display(spec.cc.join(", "))}`);
  if (spec.bcc.length) lines.push(`  bcc:         ${display(spec.bcc.join(", "))}`);
  lines.push(`  subject:     ${spec.subject ? display(spec.subject) : "(draft subject)"}`);
  if (spec.attachments.length) {
    lines.push(`  attachments: ${spec.attachments.map((a) => `${display(a.name)} (${a.size} bytes)`).join(", ")}`);
  }
  const note = describeAction(spec);
  if (note) lines.push(`  note:        ${note}`);
  if (full) {
    if (spec.attachments.length) {
      for (const a of spec.attachments) lines.push(`  attachment path: ${display(a.path)}`);
    }
    if (spec.html) lines.push("  body is HTML");
    lines.push("  body:", "  ----", ...(spec.body ? display(spec.body).split("\n").map((l) => `  ${l}`) : ["  (see note)"]), "  ----");
  }
  return lines.join("\n");
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const now = deps.now?.() ?? Date.now();
  const [command, id] = argv;

  if (command === "pending") {
    const queue = listPending();
    if (queue.length === 0) {
      print("No sends waiting for approval.");
      return 0;
    }
    print(queue.map((spec) => formatPending(spec, now, false)).join("\n\n"));
    return 0;
  }

  if (command === "show" || command === "approve" || command === "reject") {
    if (!id) {
      print(`${command} needs a pending id.\n${USAGE}`);
      return 2;
    }
    let found: { spec: PendingSend; digest: string } | undefined;
    try {
      found = readPendingWithDigest(id);
    } catch (err) {
      print((err as Error).message);
      return 1;
    }
    if (!found) {
      print(`No pending send with id ${id}. Run \`mailbox-mcp pending\` to list the queue.`);
      return 1;
    }
    if (command === "show") {
      print(formatPending(found.spec, now));
      return 0;
    }
    if (command === "reject") {
      removePending(found.spec.id);
      print(`Rejected ${found.spec.id}. Nothing was sent.`);
      return 0;
    }
    return approve(found.spec, found.digest, deps, print, now);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    print(USAGE);
    return 0;
  }
  print(`Unknown command "${command}".\n${USAGE}`);
  return 2;
}

async function approve(spec: PendingSend, digest: string, deps: CliDeps, print: (line: string) => void, now: number): Promise<number> {
  print(formatPending(spec, now));
  if (isExpired(spec, now)) {
    print(`Not sent: ${spec.id} was queued more than 7 days ago and has expired. Run \`mailbox-mcp reject ${spec.id}\` to remove it, or ask for the message again.`);
    return 1;
  }
  const hidden = hiddenCharacterCount(spec);
  if (hidden > 0) {
    print(`Not sent: the message contains ${hidden} control, bidirectional or zero-width characters, which can make the terminal show something other than what would be sent. Run \`mailbox-mcp reject ${spec.id}\` and ask for it again without them.`);
    return 1;
  }

  let tty: Terminal;
  try {
    tty = (deps.openTerminal ?? openTty)();
  } catch (err) {
    print(`Not sent: ${(err as Error).message}`);
    return 1;
  }

  try {
    const manager = new AccountManager();
    let config: AccountConfig;
    try {
      config = manager.getAccount(spec.account);
    } catch (err) {
      print(`Not sent: ${(err as Error).message}`);
      return 1;
    }
    if (config.readOnly) {
      print(`Not sent: account "${spec.account}" is configured read-only.`);
      return 1;
    }
    if (config.draftsOnly) {
      print(`Not sent: account "${spec.account}" is configured draftsOnly.`);
      return 1;
    }

    const provider = await (deps.getProvider ?? createProvider)(spec.account, config, manager.getConfigDir());
    let recipients = allRecipients(spec);
    if (spec.action.kind === "sendDraft") {
      const unchanged = await draftUnchanged(spec, provider);
      if (unchanged !== null) {
        print(`Not sent: ${unchanged}`);
        return 1;
      }
      recipients = await provider.getDraftRecipients!(spec.action.draftId);
    }
    // The user is approving in person, so the two confirmations are given;
    // the allowlist and the daily cap are re-checked against today's state.
    const error = await checkOutgoing({
      account: spec.account, config, provider, recipients,
      confirmNewRecipient: true, isForward: spec.action.kind === "forward", confirmExternalForward: true,
    });
    if (error) {
      print(`Not sent: ${error}`);
      return 1;
    }

    let attachments: Attachment[] | undefined;
    try {
      attachments = loadAttachments(spec.attachments.map((a) => a.path));
      spec.attachments.forEach((a, i) => {
        const size = attachments![i].data.length;
        if (size !== a.size) throw new Error(`Attachment ${a.path} changed since it was queued (${a.size} bytes then, ${size} now).`);
      });
    } catch (err) {
      print(`Not sent: ${(err as Error).message}`);
      return 1;
    }

    tty.write(`Send this message from account "${spec.account}"? Type yes to send: `);
    const answer = tty.readLine().trim();
    if (answer !== "yes") {
      print("Not sent. The message stays in the queue.");
      return 1;
    }

    // What was displayed came from memory; make sure the file on disk is still
    // that same message before acting in its name.
    if (readPendingWithDigest(spec.id)?.digest !== digest) {
      print(`Not sent: the pending file for ${spec.id} changed or disappeared while you were approving. Run \`mailbox-mcp show ${spec.id}\` and start again.`);
      return 1;
    }

    let messageId: string;
    try {
      messageId = await dispatch(spec, provider, attachments);
    } catch (err) {
      print(`Send failed: ${redactTokens((err as Error).message ?? String(err))}. The message stays in the queue.`);
      return 1;
    }
    recordSend(spec.account, spec.tool, recipients);
    removePending(spec.id);
    print(`Sent. Message ID: ${messageId}`);
    return 0;
  } finally {
    tty.close();
  }
}

// A queued send_draft is bound to the draft as it was at queue time: same
// provider fingerprint and the same recipient set, or it is refused.
async function draftUnchanged(spec: PendingSend, provider: MailProvider): Promise<string | null> {
  if (spec.action.kind !== "sendDraft") return null;
  if (!provider.draftFingerprint || !provider.getDraftRecipients) {
    return "this provider cannot verify that the draft is unchanged since it was queued.";
  }
  const current = await provider.draftFingerprint(spec.action.draftId);
  if (current !== spec.action.fingerprint) {
    return `draft ${spec.action.draftId} changed since it was queued. Reject this entry and queue the send again after reviewing the draft.`;
  }
  const set = (list: string[]) => list.map(extractAddress).sort().join(",");
  if (set(await provider.getDraftRecipients(spec.action.draftId)) !== set(allRecipients(spec))) {
    return `draft ${spec.action.draftId} now has different recipients than when it was queued. Reject this entry and queue the send again.`;
  }
  return null;
}

function dispatch(spec: PendingSend, provider: MailProvider, attachments: Attachment[] | undefined): Promise<string> {
  const cc = spec.cc.length ? spec.cc : undefined;
  const bcc = spec.bcc.length ? spec.bcc : undefined;
  switch (spec.action.kind) {
    case "send":
      return provider.sendMessage(spec.to, spec.subject, spec.body, { from: spec.from, cc, bcc, html: spec.html, attachments });
    case "reply":
      return provider.replyToMessage(spec.action.messageId, spec.body, { from: spec.from, replyAll: spec.action.replyAll, cc, bcc, html: spec.html, attachments });
    case "forward":
      return provider.forwardMessage(spec.action.messageId, spec.to, { from: spec.from, message: spec.body || undefined, html: spec.html, attachments });
    case "sendDraft":
      return provider.sendDraft(spec.action.draftId);
  }
}
