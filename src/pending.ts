import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

// Sends held for out-of-band approval. Each one is a file under
// <config dir>/pending/ holding everything needed to send it later, so the
// CLI can show the user exactly what will go out and send that and nothing
// else. The MCP side can only add to this directory; approving, listing and
// rejecting are CLI-only on purpose, so no tool call can complete a send.
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingReason = "approval" | "untrusted-read";

export type PendingAction =
  | { kind: "send" }
  | { kind: "reply"; messageId: string; replyAll?: boolean }
  | { kind: "forward"; messageId: string }
  | { kind: "sendDraft"; draftId: string; fingerprint: string };

export interface PendingAttachment {
  path: string;
  name: string;
  size: number;
}

export interface PendingSend {
  id: string;
  createdAt: string;
  account: string;
  tool: string;
  reason: PendingReason;
  /** Why the lock fired, when reason is "untrusted-read". */
  taintedBy?: string;
  action: PendingAction;
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: boolean;
  attachments: PendingAttachment[];
}

const ID_PATTERN = /^[0-9a-f]{8}$/;

export function pendingDir(): string {
  return join(process.env.MAILBOX_MCP_CONFIG_DIR || join(homedir(), ".mailbox-mcp"), "pending");
}

function pendingPath(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid pending id "${id}"`);
  return join(pendingDir(), `${id}.json`);
}

export function queueSend(spec: Omit<PendingSend, "id" | "createdAt">): PendingSend {
  const dir = pendingDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (let attempt = 0; ; attempt++) {
    const full: PendingSend = { id: randomBytes(4).toString("hex"), createdAt: new Date().toISOString(), ...spec };
    const path = pendingPath(full.id);
    try {
      writeFileSync(path, JSON.stringify(full, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 5) continue;
      throw err;
    }
    chmodSync(path, 0o600);
    return full;
  }
}

// Reads through a descriptor opened with O_NOFOLLOW and checked to be a
// regular file, so a symlink or anything else dropped into pending/ is
// refused rather than followed. The digest lets approve prove the file it
// displayed is the file it is about to act on.
function readPendingFile(path: string): { spec: PendingSend; digest: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Refusing ${path}: not a regular file`);
    const raw = readFileSync(fd);
    return { spec: JSON.parse(raw.toString("utf-8")) as PendingSend, digest: createHash("sha256").update(raw).digest("hex") };
  } finally {
    closeSync(fd);
  }
}

export function readPendingWithDigest(id: string): { spec: PendingSend; digest: string } | undefined {
  const path = pendingPath(id);
  if (!existsSync(path)) return undefined;
  return readPendingFile(path);
}

export function readPending(id: string): PendingSend | undefined {
  return readPendingWithDigest(id)?.spec;
}

export function listPending(): PendingSend[] {
  const dir = pendingDir();
  if (!existsSync(dir)) return [];
  const out: PendingSend[] = [];
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !ID_PATTERN.test(id)) continue;
    try {
      out.push(readPendingFile(join(dir, name)).spec);
    } catch {
      // A torn, hand-edited or non-regular file must not hide the rest of the queue.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function removePending(id: string): boolean {
  const path = pendingPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function isExpired(spec: PendingSend, now: number = Date.now()): boolean {
  return now - Date.parse(spec.createdAt) > PENDING_TTL_MS;
}

export function allRecipients(spec: PendingSend): string[] {
  return [...spec.to, ...spec.cc, ...spec.bcc];
}
