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
});
