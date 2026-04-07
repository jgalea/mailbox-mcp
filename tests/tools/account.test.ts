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
});
