import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isExpired, listPending, pendingDir, PENDING_TTL_MS, queueSend, readPending, readPendingWithDigest, removePending, type PendingSend } from "../src/pending.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "mbx-pending-"));
  process.env.MAILBOX_MCP_CONFIG_DIR = configDir;
});

afterEach(() => {
  delete process.env.MAILBOX_MCP_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

const base = {
  account: "personal", tool: "send_email", reason: "approval" as const, action: { kind: "send" as const },
  to: ["a@example.com"], cc: [], bcc: [], subject: "s", body: "b", attachments: [],
};

function writeSpec(id: string, createdAt: string): void {
  mkdirSync(pendingDir(), { recursive: true });
  const spec: PendingSend = { ...base, id, createdAt };
  writeFileSync(join(pendingDir(), `${id}.json`), JSON.stringify(spec));
}

describe("pending queue", () => {
  it("writes under <config dir>/pending with 0700 on the directory and 0600 on the file", () => {
    const spec = queueSend(base);
    expect(spec.id).toMatch(/^[0-9a-f]{8}$/);
    expect(pendingDir()).toBe(join(configDir, "pending"));
    expect(statSync(pendingDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(pendingDir(), `${spec.id}.json`)).mode & 0o777).toBe(0o600);
    expect(readPending(spec.id)).toEqual(spec);
  });

  it("lists in creation order and skips a file that does not parse", () => {
    writeSpec("bbbbbbbb", "2026-10-02T00:00:00.000Z");
    writeSpec("aaaaaaaa", "2026-10-01T00:00:00.000Z");
    writeFileSync(join(pendingDir(), "cccccccc.json"), "{not json");
    writeFileSync(join(pendingDir(), "notes.txt"), "ignored");
    expect(listPending().map((s) => s.id)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("returns an empty list when nothing was ever queued", () => {
    expect(existsSync(pendingDir())).toBe(false);
    expect(listPending()).toEqual([]);
  });

  it("refuses ids that are not eight hex characters", () => {
    for (const bad of ["../x", "ABCDEF12", "abc", "aaaaaaaa.json", ""]) {
      expect(() => readPending(bad), bad).toThrow(/Invalid pending id/);
      expect(() => removePending(bad), bad).toThrow(/Invalid pending id/);
    }
  });

  it("refuses to read through a symlink or a non-regular file, and the listing skips it", () => {
    writeSpec("aaaaaaaa", "2026-10-01T00:00:00.000Z");
    const outside = join(configDir, "outside.json");
    writeFileSync(outside, JSON.stringify({ ...base, id: "bbbbbbbb", createdAt: "2026-10-01T00:00:00.000Z" }));
    symlinkSync(outside, join(pendingDir(), "bbbbbbbb.json"));
    mkdirSync(join(pendingDir(), "cccccccc.json"));
    expect(() => readPending("bbbbbbbb")).toThrow(/ELOOP|symbolic|symlink/i);
    expect(() => readPending("cccccccc")).toThrow();
    expect(listPending().map((s) => s.id)).toEqual(["aaaaaaaa"]);
  });

  it("returns a digest that changes when the file does", () => {
    const spec = queueSend(base);
    const first = readPendingWithDigest(spec.id)!.digest;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(pendingDir(), `${spec.id}.json`), JSON.stringify({ ...spec, body: "tampered" }));
    expect(readPendingWithDigest(spec.id)!.digest).not.toBe(first);
  });

  it("removePending deletes the file and reports whether it existed", () => {
    const spec = queueSend(base);
    expect(removePending(spec.id)).toBe(true);
    expect(readPending(spec.id)).toBeUndefined();
    expect(removePending(spec.id)).toBe(false);
  });

  it("never overwrites an existing entry on an id collision", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(queueSend(base).id);
    expect(ids.size).toBe(50);
    expect(listPending()).toHaveLength(50);
  });

  it("expires after seven days", () => {
    const spec = queueSend(base);
    const created = Date.parse(spec.createdAt);
    expect(isExpired(spec, created + PENDING_TTL_MS - 1)).toBe(false);
    expect(isExpired(spec, created + PENDING_TTL_MS + 1)).toBe(true);
    expect(PENDING_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
