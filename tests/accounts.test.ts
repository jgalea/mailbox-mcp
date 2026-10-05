import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccountManager, hasGuards, tightenGuards, type AccountGuards } from "../src/accounts.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AccountManager", () => {
  let tempDir: string;
  let manager: AccountManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mailbox-mcp-test-"));
    manager = new AccountManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts with no accounts", () => {
    expect(manager.listAccounts()).toEqual({});
  });

  it("adds a Gmail account", () => {
    manager.addAccount("personal", { provider: "gmail", email: "user@example.com" });
    const accounts = manager.listAccounts();
    expect(accounts["personal"]).toEqual({ provider: "gmail", email: "user@example.com" });
  });

  it("adds an IMAP account", () => {
    manager.addAccount("work", {
      provider: "imap", email: "user@work.example.com",
      host: "imap.company.com", port: 993,
      smtpHost: "smtp.company.com", smtpPort: 587,
    });
    const accounts = manager.listAccounts();
    expect(accounts["work"].provider).toBe("imap");
    expect(accounts["work"].email).toBe("user@work.example.com");
  });

  it("persists accounts to disk", () => {
    manager.addAccount("personal", { provider: "gmail", email: "user@example.com" });
    const reloaded = new AccountManager(tempDir);
    expect(reloaded.listAccounts()["personal"].email).toBe("user@example.com");
  });

  it("removes an account", () => {
    manager.addAccount("personal", { provider: "gmail", email: "user@example.com" });
    manager.removeAccount("personal");
    expect(manager.listAccounts()).toEqual({});
  });

  it("cleans up account directory on removeAccount", () => {
    manager.addAccount("personal", { provider: "gmail", email: "user@example.com" });
    const accountDir = manager.getAccountDir("personal");
    expect(existsSync(accountDir)).toBe(true);
    manager.removeAccount("personal");
    expect(existsSync(accountDir)).toBe(false);
  });

  it("throws on duplicate alias", () => {
    manager.addAccount("personal", { provider: "gmail", email: "user@example.com" });
    expect(() =>
      manager.addAccount("personal", { provider: "gmail", email: "other@gmail.com" })
    ).toThrow("already exists");
  });

  it("throws on remove of non-existent account", () => {
    expect(() => manager.removeAccount("nope")).toThrow("not found");
  });

  it("validates alias format", () => {
    expect(() =>
      manager.addAccount("../evil", { provider: "gmail", email: "a@b.com" })
    ).toThrow("Invalid alias");
  });

  it("persists per-account guard settings", () => {
    manager.addAccount("locked", {
      provider: "gmail", email: "user@example.com",
      readOnly: true, draftsOnly: true, allowedRecipients: ["boss@example.com", "@example.org"], dailySendLimit: 5,
    });
    const reloaded = new AccountManager(tempDir).getAccount("locked");
    expect(reloaded.readOnly).toBe(true);
    expect(reloaded.draftsOnly).toBe(true);
    expect(reloaded.allowedRecipients).toEqual(["boss@example.com", "@example.org"]);
    expect(reloaded.dailySendLimit).toBe(5);
  });

  it("rejects malformed allowlist entries and limits", () => {
    expect(() => manager.addAccount("a", { provider: "gmail", email: "u@example.com", allowedRecipients: ["not-an-address"] })).toThrow("allowedRecipients");
    expect(() => manager.addAccount("b", { provider: "gmail", email: "u@example.com", allowedRecipients: ["example.com"] })).toThrow("allowedRecipients");
    expect(() => manager.addAccount("c", { provider: "gmail", email: "u@example.com", dailySendLimit: -1 })).toThrow("dailySendLimit");
    expect(() => manager.addAccount("d", { provider: "gmail", email: "u@example.com", dailySendLimit: 1.5 })).toThrow("dailySendLimit");
    expect(manager.listAccounts()).toEqual({});
  });

  it("persists approval and untrustedReadLock", () => {
    manager.addAccount("gated", { provider: "gmail", email: "user@example.com", approval: "external", untrustedReadLock: "refuse" });
    const reloaded = new AccountManager(tempDir).getAccount("gated");
    expect(reloaded.approval).toBe("external");
    expect(reloaded.untrustedReadLock).toBe("refuse");
  });

  it("rejects unknown approval and untrustedReadLock values", () => {
    expect(() => manager.addAccount("a", { provider: "gmail", email: "u@example.com", approval: true as any })).toThrow(/approval must be "external"/);
    expect(() => manager.addAccount("b", { provider: "gmail", email: "u@example.com", approval: "internal" as any })).toThrow(/approval must be "external"/);
    expect(() => manager.addAccount("c", { provider: "gmail", email: "u@example.com", untrustedReadLock: "block" as any })).toThrow(/untrustedReadLock must be "approval" or "refuse"/);
    expect(manager.listAccounts()).toEqual({});
    writeFileSync(join(tempDir, "accounts.json"), JSON.stringify({ accounts: { x: { provider: "gmail", email: "u@example.com", untrustedReadLock: true } } }));
    expect(() => new AccountManager(tempDir)).toThrow(/account "x".*untrustedReadLock/);
  });

  it("validates authservId as a hostname", () => {
    expect(() => manager.addAccount("a", { provider: "gmail", email: "u@example.com", authservId: "mx.google.com; dmarc=pass" })).toThrow(/authservId must be a hostname/);
    manager.addAccount("b", { provider: "gmail", email: "u@example.com", authservId: "mx1.messagingengine.com" });
    expect(new AccountManager(tempDir).getAccount("b").authservId).toBe("mx1.messagingengine.com");
  });

  describe("guards can only be kept or tightened", () => {
    const strict: AccountGuards = {
      readOnly: true, approval: "external", untrustedReadLock: "refuse", dailySendLimit: 5,
      allowedRecipients: ["@example.com", "boss@example.org"], authservId: "mx.example.com",
    };

    it("tightenGuards never loosens any field", () => {
      const loose: AccountGuards = {
        readOnly: false, draftsOnly: false, untrustedReadLock: "approval", dailySendLimit: 500,
        allowedRecipients: ["anyone@example.com", "@attacker.example", "boss@example.org", "leak@attacker.example"], authservId: "mx.attacker.example",
      };
      expect(tightenGuards(strict, loose)).toEqual({
        readOnly: true, approval: "external", untrustedReadLock: "refuse", dailySendLimit: 5,
        allowedRecipients: ["anyone@example.com", "boss@example.org"], authservId: "mx.example.com",
      });
      expect(tightenGuards(strict, {})).toEqual(strict);
      expect(tightenGuards(strict, { allowedRecipients: [] })).toMatchObject({ allowedRecipients: strict.allowedRecipients });
      expect(tightenGuards(strict, { allowedRecipients: ["leak@attacker.example"] })).toMatchObject({ allowedRecipients: strict.allowedRecipients });
    });

    it("tightenGuards takes a stricter incoming value", () => {
      expect(tightenGuards({}, { draftsOnly: true, dailySendLimit: 3, allowedRecipients: ["a@example.com"], untrustedReadLock: "approval" }))
        .toEqual({ draftsOnly: true, dailySendLimit: 3, allowedRecipients: ["a@example.com"], untrustedReadLock: "approval" });
      expect(tightenGuards({ untrustedReadLock: "approval", dailySendLimit: 10 }, { untrustedReadLock: "refuse", dailySendLimit: 2, readOnly: true }))
        .toEqual({ untrustedReadLock: "refuse", dailySendLimit: 2, readOnly: true });
      expect(tightenGuards({}, { authservId: "mx.attacker.example" })).toEqual({});
    });

    it("replaceAccount keeps the guards and takes the new connection details", () => {
      manager.addAccount("work", { provider: "gmail", email: "old@example.com", ...strict });
      const merged = manager.replaceAccount("work", { provider: "gmail", email: "new@example.com", dailySendLimit: 100 });
      expect(merged).toEqual({ provider: "gmail", email: "new@example.com", ...strict });
      expect(new AccountManager(tempDir).getAccount("work")).toEqual(merged);
      expect(() => manager.replaceAccount("nope", { provider: "gmail", email: "x@example.com" })).toThrow("not found");
    });

    it("removeAccount refuses while any guard is set, and says to edit accounts.json", () => {
      manager.addAccount("work", { provider: "gmail", email: "u@example.com", ...strict });
      expect(() => manager.removeAccount("work")).toThrow(/safety settings \(readOnly, allowedRecipients, dailySendLimit, approval, untrustedReadLock\).*Edit accounts.json/);
      expect(manager.listAccounts().work).toBeDefined();
      manager.addAccount("open", { provider: "gmail", email: "o@example.com", allowedRecipients: [] });
      manager.removeAccount("open");
      expect(manager.listAccounts().open).toBeUndefined();
      expect(hasGuards({})).toBe(false);
      expect(hasGuards({ draftsOnly: true })).toBe(true);
    });
  });

  it("refuses to load an accounts.json with a malformed allowlist", () => {
    writeFileSync(join(tempDir, "accounts.json"), JSON.stringify({ accounts: { x: { provider: "gmail", email: "u@example.com", allowedRecipients: "boss@example.com" } } }));
    expect(() => new AccountManager(tempDir)).toThrow(/account "x"/);
  });

  it("honours MAILBOX_MCP_CONFIG_DIR when no directory is given", () => {
    process.env.MAILBOX_MCP_CONFIG_DIR = tempDir;
    try {
      expect(new AccountManager().getConfigDir()).toBe(tempDir);
    } finally {
      delete process.env.MAILBOX_MCP_CONFIG_DIR;
    }
  });
});
