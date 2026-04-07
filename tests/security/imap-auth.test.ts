import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptCredentials, decryptCredentials } from "../../src/auth/imap-auth.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDir } from "../../src/security/permissions.js";

const TEST_PASSPHRASE = "test-passphrase-for-unit-tests";

describe("IMAP credential encryption", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mailbox-mcp-test-"));
    ensureDir(join(tempDir, "accounts", "work"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("encrypts and decrypts credentials round-trip", () => {
    const creds = { username: "user@work.example.com", password: "s3cret!" };
    encryptCredentials(tempDir, "work", creds, TEST_PASSPHRASE);
    const decrypted = decryptCredentials(tempDir, "work", TEST_PASSPHRASE);
    expect(decrypted.username).toBe("user@work.example.com");
    expect(decrypted.password).toBe("s3cret!");
  });

  it("throws when no credentials exist", () => {
    expect(() => decryptCredentials(tempDir, "nonexistent", TEST_PASSPHRASE)).toThrow();
  });

  it("produces different ciphertext each time (random salt and IV)", () => {
    const creds = { username: "a@b.com", password: "pw" };
    encryptCredentials(tempDir, "work", creds, TEST_PASSPHRASE);
    const first = readFileSync(join(tempDir, "accounts", "work", "credentials.json"), "utf-8");
    encryptCredentials(tempDir, "work", creds, TEST_PASSPHRASE);
    const second = readFileSync(join(tempDir, "accounts", "work", "credentials.json"), "utf-8");
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with wrong passphrase", () => {
    const creds = { username: "a@b.com", password: "pw" };
    encryptCredentials(tempDir, "work", creds, TEST_PASSPHRASE);
    expect(() => decryptCredentials(tempDir, "work", "wrong-passphrase")).toThrow();
  });

  it("throws when passphrase is empty", () => {
    const creds = { username: "a@b.com", password: "pw" };
    expect(() => encryptCredentials(tempDir, "work", creds, "")).toThrow("passphrase is required");
    expect(() => decryptCredentials(tempDir, "work", "")).toThrow("passphrase is required");
  });

  it("stores salt alongside IV and authTag", () => {
    const creds = { username: "a@b.com", password: "pw" };
    encryptCredentials(tempDir, "work", creds, TEST_PASSPHRASE);
    const stored = JSON.parse(readFileSync(join(tempDir, "accounts", "work", "credentials.json"), "utf-8"));
    expect(stored).toHaveProperty("salt");
    expect(stored).toHaveProperty("iv");
    expect(stored).toHaveProperty("authTag");
    expect(stored).toHaveProperty("data");
  });
});
