import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// Append-only log of reversible bulk operations. Each line is a JSON record of
// the IDs touched and what changed, so a later `undo_bulk_op` call can mint
// the inverse without needing to re-search Gmail.
const LOG_MAX_BYTES = 50 * 1024 * 1024; // 50MB — large because IDs are bulky.

function logDir(): string {
  return process.env.MAILBOX_MCP_LOG_DIR || join(homedir(), ".mailbox-mcp");
}
function logPath(): string {
  return join(logDir(), "transactions.jsonl");
}

export interface TransactionRecord {
  id: string;
  ts: string;
  account: string;
  tool: "bulk_modify" | "bulk_trash";
  query: string;
  folder?: string;
  add_labels: string[];
  remove_labels: string[];
  message_ids: string[];
  reversed_at?: string;
  reversed_by?: string;
}

function ensureLogDir(): void {
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
}

function rotateIfNeeded(): void {
  const path = logPath();
  try {
    if (statSync(path).size > LOG_MAX_BYTES) {
      renameSync(path, path + ".old");
    }
  } catch {
    // File doesn't exist yet — nothing to rotate.
  }
}

export function recordTransaction(rec: Omit<TransactionRecord, "id" | "ts">): TransactionRecord {
  ensureLogDir();
  rotateIfNeeded();
  const full: TransactionRecord = {
    id: randomBytes(8).toString("hex"),
    ts: new Date().toISOString(),
    ...rec,
  };
  appendFileSync(logPath(), JSON.stringify(full) + "\n", { mode: 0o600 });
  return full;
}

export function listTransactions(opts: { account?: string; limit?: number } = {}): TransactionRecord[] {
  const path = logPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const records: TransactionRecord[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as TransactionRecord;
      if (opts.account && r.account !== opts.account) continue;
      records.push(r);
    } catch {
      // Skip malformed lines so a single bad write can't break listing.
    }
  }
  records.reverse();
  if (opts.limit) return records.slice(0, opts.limit);
  return records;
}

export function findTransaction(id: string): TransactionRecord | undefined {
  const path = logPath();
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]) as TransactionRecord;
      if (r.id === id) return r;
    } catch { /* skip */ }
  }
  return undefined;
}

export function markReversed(id: string, reversedBy: string): void {
  const path = logPath();
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const updated: string[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as TransactionRecord;
      if (r.id === id) {
        r.reversed_at = new Date().toISOString();
        r.reversed_by = reversedBy;
        updated.push(JSON.stringify(r));
      } else {
        updated.push(line);
      }
    } catch {
      updated.push(line);
    }
  }
  // Atomic-ish replace: write to a tmp file then rename.
  const tmp = path + ".tmp";
  appendFileSync(tmp, updated.join("\n") + "\n", { mode: 0o600, flag: "w" });
  renameSync(tmp, path);
}
