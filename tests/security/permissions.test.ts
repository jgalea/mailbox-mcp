import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureDir, secureWriteFile } from "../../src/security/permissions.js";
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("file permissions", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mailbox-mcp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ensureDir creates directory with 0o700", () => {
    const dir = join(tempDir, "secure");
    ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
    const stat = statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("secureWriteFile writes with 0o600", () => {
    const file = join(tempDir, "secret.json");
    secureWriteFile(file, '{"token": "abc"}');
    expect(readFileSync(file, "utf-8")).toBe('{"token": "abc"}');
    const stat = statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
