import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { extractAddress } from "./providers/headers.js";

// Append-only record of every message sent through this server: one line per
// send with the account and the bare recipient addresses. It backs the daily
// send cap (survives restarts) and the "have we written to this address
// before" half of the new-recipient check.
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function logDir(): string {
  return process.env.MAILBOX_MCP_LOG_DIR || join(homedir(), ".mailbox-mcp");
}
function logPath(): string {
  return join(logDir(), "sends.jsonl");
}

interface SendRecord {
  ts: string;
  account: string;
  tool: string;
  to: string[];
}

function readRecords(): SendRecord[] {
  const out: SendRecord[] = [];
  for (const path of [logPath() + ".old", logPath()]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SendRecord);
      } catch {
        // A torn write must not take the whole log down with it.
      }
    }
  }
  return out;
}

export function recordSend(account: string, tool: string, recipients: string[]): void {
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
  try {
    if (statSync(logPath()).size > LOG_MAX_BYTES) renameSync(logPath(), logPath() + ".old");
  } catch {
    // Nothing to rotate yet.
  }
  const rec: SendRecord = {
    ts: new Date().toISOString(),
    account,
    tool,
    to: recipients.map(extractAddress).filter(Boolean),
  };
  appendFileSync(logPath(), (endsWithNewline(logPath()) ? "" : "\n") + JSON.stringify(rec) + "\n", { mode: 0o600 });
}

// A torn previous write (no trailing newline) would otherwise swallow the next
// record into the same unparsable line.
function endsWithNewline(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size === 0) return true;
    const fd = openSync(path, "r");
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] === 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }
}

export function sendsInLastDay(account: string, now: number = Date.now()): number {
  const cutoff = now - DAY_MS;
  return readRecords().filter((r) => r.account === account && Date.parse(r.ts) > cutoff).length;
}

export function hasSentTo(account: string, address: string): boolean {
  const needle = extractAddress(address);
  return readRecords().some((r) => r.account === account && r.to.includes(needle));
}
