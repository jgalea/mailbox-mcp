import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccountManager } from "../src/accounts.js";
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
