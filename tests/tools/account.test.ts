import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountManager } from "../../src/accounts.js";
import { handleToolCall, type ToolContext } from "../../src/tools/registry.js";
import "../../src/tools/account.js";

describe("account tools", () => {
  let tempDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mailbox-mcp-test-"));
    const accountManager = new AccountManager(tempDir);
    ctx = { accountManager, getProvider: vi.fn() };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("list_accounts returns empty when no accounts", async () => {
    const result = await handleToolCall("list_accounts", {}, ctx);
    expect(result.content[0].text).toContain("No accounts configured");
  });

  it("list_accounts shows configured accounts", async () => {
    ctx.accountManager.addAccount("personal", { provider: "gmail", email: "user@example.com" });
    const result = await handleToolCall("list_accounts", {}, ctx);
    expect(result.content[0].text).toContain("personal");
    expect(result.content[0].text).toContain("gmail");
    expect(result.content[0].text).toContain("user@example.com");
  });

  it("list_accounts shows approval and the untrusted-read lock like the other flags", async () => {
    ctx.accountManager.addAccount("gated", { provider: "gmail", email: "user@example.com", approval: "external", untrustedReadLock: "refuse", readOnly: false });
    const result = await handleToolCall("list_accounts", {}, ctx);
    expect(result.content[0].text).toContain("approval: external");
    expect(result.content[0].text).toContain("untrusted-read lock: refuse");
    expect(result.content[0].text).not.toContain("read-only");
  });

  it("authenticate accepts approval and untrusted_read_lock and ignores other values", async () => {
    process.env.MAILBOX_MCP_PASSPHRASE = "test-passphrase";
    try {
      const imap = { provider: "imap", host: "imap.example.com", smtpHost: "smtp.example.com", username: "u", password: "p" };
      const ok = await handleToolCall("authenticate", { ...imap, alias: "gated", email: "u@example.com", approval: "external", untrusted_read_lock: "approval" }, ctx);
      expect(ok.isError).toBeUndefined();
      expect(ctx.accountManager.getAccount("gated")).toMatchObject({ approval: "external", untrustedReadLock: "approval" });

      const loose = await handleToolCall("authenticate", { ...imap, alias: "plain", email: "p@example.com", approval: "none", untrusted_read_lock: "maybe" }, ctx);
      expect(loose.isError).toBeUndefined();
      const plain = ctx.accountManager.getAccount("plain");
      expect(plain.approval).toBeUndefined();
      expect(plain.untrustedReadLock).toBeUndefined();
    } finally {
      delete process.env.MAILBOX_MCP_PASSPHRASE;
    }
  });

  it("authenticate refuses an existing alias, guarded or not, without touching it", async () => {
    process.env.MAILBOX_MCP_PASSPHRASE = "test-passphrase";
    try {
      const imap = { provider: "imap", host: "imap.attacker.example", smtpHost: "smtp.attacker.example", username: "u", password: "p", email: "other@attacker.example" };
      const original = { provider: "imap" as const, email: "u@example.com", host: "imap.example.com", port: 993, smtpHost: "smtp.example.com", smtpPort: 587, approval: "external" as const, untrustedReadLock: "approval" as const, allowedRecipients: ["@example.com"], dailySendLimit: 5 };
      ctx.accountManager.addAccount("gated", original);
      const guarded = await handleToolCall("authenticate", { ...imap, alias: "gated", daily_send_limit: 500 }, ctx);
      expect(guarded.isError).toBe(true);
      expect(guarded.content[0].text).toMatch(/already exists and has safety settings \(allowedRecipients, dailySendLimit, approval, untrustedReadLock\).*edit accounts.json/);
      expect(ctx.accountManager.getAccount("gated")).toEqual(original);

      ctx.accountManager.addAccount("plain", { provider: "gmail", email: "p@example.com" });
      const unguarded = await handleToolCall("authenticate", { ...imap, alias: "plain" }, ctx);
      expect(unguarded.isError).toBe(true);
      expect(unguarded.content[0].text).toMatch(/already exists\. Nothing about it can be changed/);
      expect(ctx.accountManager.getAccount("plain")).toEqual({ provider: "gmail", email: "p@example.com" });
    } finally {
      delete process.env.MAILBOX_MCP_PASSPHRASE;
    }
  });

  it("authenticate never takes trusted_senders or authserv_id, and list_accounts shows them when set in the file", async () => {
    process.env.MAILBOX_MCP_PASSPHRASE = "test-passphrase";
    try {
      const imap = { provider: "imap", host: "imap.example.com", smtpHost: "smtp.example.com", username: "u", password: "p" };
      const result = await handleToolCall("authenticate", { ...imap, alias: "fresh", email: "f@example.com", trusted_senders: ["anyone@attacker.example"], trustedSenders: ["anyone@attacker.example"], authserv_id: "mx.attacker.example", authservId: "mx.attacker.example" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(ctx.accountManager.getAccount("fresh")).toEqual({ provider: "imap", email: "f@example.com", host: "imap.example.com", port: 993, smtpHost: "smtp.example.com", smtpPort: 587 });
    } finally {
      delete process.env.MAILBOX_MCP_PASSPHRASE;
    }
    ctx.accountManager.addAccount("listed", { provider: "gmail", email: "l@example.com", untrustedReadLock: "approval", trustedSenders: ["boss@example.org", "@partner.example"], authservId: "mx.example.com" });
    const listed = await handleToolCall("list_accounts", {}, ctx);
    expect(listed.content[0].text).toContain("trusted senders: boss@example.org, @partner.example");
    expect(listed.content[0].text).toContain("authserv-id: mx.example.com");
  });

  it("remove_account refuses for an account with any guard set", async () => {
    ctx.accountManager.addAccount("gated", { provider: "gmail", email: "user@example.com", draftsOnly: true });
    const result = await handleToolCall("remove_account", { alias: "gated" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/safety settings \(draftsOnly\).*Edit accounts.json/);
    expect(ctx.accountManager.listAccounts().gated).toBeDefined();
  });

  it("remove_account removes an existing account", async () => {
    ctx.accountManager.addAccount("temp", { provider: "gmail", email: "temp@gmail.com" });
    const result = await handleToolCall("remove_account", { alias: "temp" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(ctx.accountManager.listAccounts()).toEqual({});
  });

  it("remove_account errors on non-existent account", async () => {
    const result = await handleToolCall("remove_account", { alias: "nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("reauth errors on non-existent account", async () => {
    const result = await handleToolCall("reauth", { alias: "nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("reauth rejects non-Gmail accounts", async () => {
    ctx.accountManager.addAccount("work", {
      provider: "imap",
      email: "me@work.com",
      host: "imap.work.com",
      port: 993,
      smtpHost: "smtp.work.com",
      smtpPort: 587,
    });
    const result = await handleToolCall("reauth", { alias: "work" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Gmail-only");
  });
  describe("environment credentials", () => {
    const ENV = [
      "MAILBOX_MCP_PASSPHRASE", "MAILBOX_MCP_IMAP_USERNAME", "MAILBOX_MCP_IMAP_PASSWORD", "MAILBOX_MCP_IMAP_HOST", "MAILBOX_MCP_IMAP_SMTP_HOST",
      "MAILBOX_MCP_JMAP_USERNAME", "MAILBOX_MCP_JMAP_PASSWORD", "MAILBOX_MCP_JMAP_HOST",
    ];
    const imap = { alias: "work", provider: "imap", email: "me@example.com", host: "imap.example.com", smtpHost: "smtp.example.com" };
    const jmap = { alias: "work", provider: "jmap", email: "me@example.com", host: "mail.example.com" };

    beforeEach(() => {
      process.env.MAILBOX_MCP_PASSPHRASE = "test-passphrase";
      process.env.MAILBOX_MCP_IMAP_USERNAME = "env-user";
      process.env.MAILBOX_MCP_IMAP_PASSWORD = "env-pass";
      process.env.MAILBOX_MCP_JMAP_USERNAME = "env-user";
      process.env.MAILBOX_MCP_JMAP_PASSWORD = "env-pass";
    });

    afterEach(() => {
      for (const key of ENV) delete process.env[key];
    });

    it("refuses the IMAP env credentials when no host is pinned", async () => {
      const result = await handleToolCall("authenticate", imap, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/MAILBOX_MCP_IMAP_HOST and MAILBOX_MCP_IMAP_SMTP_HOST/);
      expect(ctx.accountManager.listAccounts()).toEqual({});
    });

    it("refuses the IMAP env credentials for a host other than the pinned one", async () => {
      process.env.MAILBOX_MCP_IMAP_HOST = "imap.example.com";
      process.env.MAILBOX_MCP_IMAP_SMTP_HOST = "smtp.example.com";
      for (const hosts of [{ host: "imap.attacker.example" }, { smtpHost: "smtp.attacker.example" }]) {
        const result = await handleToolCall("authenticate", { ...imap, ...hosts }, ctx);
        expect(result.isError, JSON.stringify(hosts)).toBe(true);
        expect(result.content[0].text).toMatch(/^Refused/);
      }
      expect(ctx.accountManager.listAccounts()).toEqual({});
    });

    it("uses the IMAP env credentials for the pinned hosts", async () => {
      process.env.MAILBOX_MCP_IMAP_HOST = "IMAP.example.com";
      process.env.MAILBOX_MCP_IMAP_SMTP_HOST = "smtp.example.com";
      const result = await handleToolCall("authenticate", imap, ctx);
      expect(result.isError).toBeUndefined();
      const { decryptCredentials } = await import("../../src/auth/imap-auth.js");
      expect(decryptCredentials(tempDir, "work", "test-passphrase")).toEqual({ username: "env-user", password: "env-pass" });
    });

    it("still accepts explicit credentials for any host", async () => {
      const result = await handleToolCall("authenticate", { ...imap, host: "imap.other.example", username: "u", password: "p" }, ctx);
      expect(result.isError).toBeUndefined();
    });

    it("refuses the JMAP env credentials unless the host and any sessionUrl match the pinned host", async () => {
      const unpinned = await handleToolCall("authenticate", jmap, ctx);
      expect(unpinned.isError).toBe(true);
      expect(unpinned.content[0].text).toMatch(/MAILBOX_MCP_JMAP_HOST is set/);

      process.env.MAILBOX_MCP_JMAP_HOST = "mail.example.com";
      const otherHost = await handleToolCall("authenticate", { ...jmap, host: "mail.attacker.example" }, ctx);
      expect(otherHost.isError).toBe(true);
      const otherSession = await handleToolCall("authenticate", { ...jmap, sessionUrl: "https://mail.attacker.example/jmap" }, ctx);
      expect(otherSession.isError).toBe(true);
      expect(ctx.accountManager.listAccounts()).toEqual({});

      const ok = await handleToolCall("authenticate", { ...jmap, sessionUrl: "https://mail.example.com/jmap/session" }, ctx);
      expect(ok.isError).toBeUndefined();
      expect(ctx.accountManager.getAccount("work")).toMatchObject({ provider: "jmap", host: "mail.example.com" });
    });
  });
});
