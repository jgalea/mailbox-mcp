import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptJmapCredentials, decryptJmapCredentials } from "../../src/auth/jmap-auth.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDir } from "../../src/security/permissions.js";

const TEST_PASSPHRASE = "test-passphrase-for-unit-tests";

describe("JMAP credential encryption", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mailbox-mcp-jmap-test-"));
    ensureDir(join(tempDir, "accounts", "fastmail"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("encrypts and decrypts credentials round-trip", () => {
    const creds = { username: "user@example.com", password: "app-pass-123" };
    encryptJmapCredentials(tempDir, "fastmail", creds, TEST_PASSPHRASE);
    const decrypted = decryptJmapCredentials(tempDir, "fastmail", TEST_PASSPHRASE);
    expect(decrypted.username).toBe("user@example.com");
    expect(decrypted.password).toBe("app-pass-123");
  });

  it("throws when no credentials exist", () => {
    expect(() => decryptJmapCredentials(tempDir, "nonexistent", TEST_PASSPHRASE)).toThrow();
  });

  it("produces different ciphertext each time (random salt and IV)", () => {
    const creds = { username: "a@b.com", password: "pw" };
    encryptJmapCredentials(tempDir, "fastmail", creds, TEST_PASSPHRASE);
    const first = readFileSync(join(tempDir, "accounts", "fastmail", "credentials.json"), "utf-8");
    encryptJmapCredentials(tempDir, "fastmail", creds, TEST_PASSPHRASE);
    const second = readFileSync(join(tempDir, "accounts", "fastmail", "credentials.json"), "utf-8");
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with wrong passphrase", () => {
    const creds = { username: "a@b.com", password: "pw" };
    encryptJmapCredentials(tempDir, "fastmail", creds, TEST_PASSPHRASE);
    expect(() => decryptJmapCredentials(tempDir, "fastmail", "wrong-passphrase")).toThrow();
  });

  it("throws when passphrase is empty", () => {
    const creds = { username: "a@b.com", password: "pw" };
    expect(() => encryptJmapCredentials(tempDir, "fastmail", creds, "")).toThrow("passphrase is required");
    expect(() => decryptJmapCredentials(tempDir, "fastmail", "")).toThrow("passphrase is required");
  });
});
