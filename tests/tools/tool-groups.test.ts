import { describe, it, expect, afterEach, vi } from "vitest";
import { getAllToolDefinitions, handleToolCall, TOOL_GROUPS, type ToolContext } from "../../src/tools/registry.js";
import "../../src/tools/account.js";
import "../../src/tools/read.js";
import "../../src/tools/write.js";
import "../../src/tools/manage.js";
import "../../src/tools/gmail-only.js";
import "../../src/tools/attachments.js";
import "../../src/tools/actions.js";
import "../../src/tools/export.js";

const ctx = {
  accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any,
  getProvider: vi.fn(),
} as ToolContext;

afterEach(() => {
  delete process.env.MAILBOX_MCP_TOOLS;
});

describe("tool groups", () => {
  it("exposes every tool when MAILBOX_MCP_TOOLS is unset", () => {
    delete process.env.MAILBOX_MCP_TOOLS;
    const names = getAllToolDefinitions().map((d) => d.name);
    expect(names.length).toBeGreaterThanOrEqual(49);
  });

  it("assigns a group to every registered tool", () => {
    delete process.env.MAILBOX_MCP_TOOLS;
    const names = getAllToolDefinitions().map((d) => d.name);
    const unmapped = names.filter((n) => !(n in TOOL_GROUPS));
    expect(unmapped).toEqual([]);
  });

  it("filters the tool list to the enabled groups", () => {
    process.env.MAILBOX_MCP_TOOLS = "core";
    const names = getAllToolDefinitions().map((d) => d.name);
    expect(names).toContain("search_emails");
    expect(names).toContain("send_email");
    expect(names).not.toContain("bulk_trash");
    expect(names).not.toContain("create_filter");
    const expectedCore = Object.values(TOOL_GROUPS).filter((g) => g === "core").length;
    expect(names.length).toBe(expectedCore);
  });

  it("accepts several groups", () => {
    process.env.MAILBOX_MCP_TOOLS = "core, attachments";
    const names = getAllToolDefinitions().map((d) => d.name);
    expect(names).toContain("download_attachment");
    expect(names).not.toContain("bulk_trash");
  });

  it("rejects calls to tools in disabled groups", async () => {
    process.env.MAILBOX_MCP_TOOLS = "core";
    const result = await handleToolCall("bulk_trash", { account: "personal", query: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("MAILBOX_MCP_TOOLS");
  });

  it("still routes calls to enabled tools", async () => {
    process.env.MAILBOX_MCP_TOOLS = "core";
    const result = await handleToolCall("list_accounts", {}, ctx);
    expect(result.content[0].text).not.toContain("disabled");
  });
});
