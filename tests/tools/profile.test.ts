import { describe, it, expect, afterEach, vi } from "vitest";
import { activeProfile, DRAFT_PROFILE_EXCLUDED, getAllToolDefinitions, handleToolCall, TOOL_ANNOTATIONS, TOOL_GROUPS, type ToolContext } from "../../src/tools/registry.js";
import "../../src/tools/account.js";
import "../../src/tools/read.js";
import "../../src/tools/write.js";
import "../../src/tools/manage.js";
import "../../src/tools/gmail-only.js";
import "../../src/tools/attachments.js";
import "../../src/tools/actions.js";
import "../../src/tools/export.js";

const ctx = {
  accountManager: { listAccounts: vi.fn().mockReturnValue({}), getAccount: vi.fn() } as any,
  getProvider: vi.fn(),
} as ToolContext;

const names = () => getAllToolDefinitions().map((d) => d.name);

afterEach(() => {
  delete process.env.MAILBOX_MCP_PROFILE;
  delete process.env.MAILBOX_MCP_TOOLS;
});

describe("MAILBOX_MCP_PROFILE", () => {
  it("defaults to full when unset, empty or 'full'", () => {
    delete process.env.MAILBOX_MCP_PROFILE;
    expect(activeProfile()).toBe("full");
    expect(names()).toHaveLength(49);
    process.env.MAILBOX_MCP_PROFILE = "";
    expect(activeProfile()).toBe("full");
    process.env.MAILBOX_MCP_PROFILE = " Full ";
    expect(activeProfile()).toBe("full");
  });

  it("fails loudly on an unknown value", () => {
    process.env.MAILBOX_MCP_PROFILE = "readonly";
    expect(() => activeProfile()).toThrow(/MAILBOX_MCP_PROFILE must be "full", "draft" or "read" \(got "readonly"\)/);
    expect(() => getAllToolDefinitions()).toThrow(/MAILBOX_MCP_PROFILE/);
  });

  it("read lists exactly the tools annotated readOnlyHint", () => {
    process.env.MAILBOX_MCP_PROFILE = "read";
    const expected = Object.entries(TOOL_ANNOTATIONS).filter(([, a]) => a.readOnlyHint === true).map(([n]) => n).sort();
    expect(names().sort()).toEqual(expected);
    expect(names()).toContain("search_emails");
    expect(names()).not.toContain("create_draft");
    expect(names()).not.toContain("send_email");
  });

  it("draft lists everything except the tools that can make mail leave", () => {
    process.env.MAILBOX_MCP_PROFILE = "draft";
    const listed = names();
    expect(listed).toHaveLength(49 - DRAFT_PROFILE_EXCLUDED.size);
    for (const excluded of DRAFT_PROFILE_EXCLUDED) expect(listed, excluded).not.toContain(excluded);
    expect(listed).toContain("create_draft");
    expect(listed).toContain("update_draft");
    expect(listed).toContain("trash_emails");
    expect(listed).toContain("bulk_trash");
  });

  it("the draft exclusion list is the one the README documents", () => {
    expect([...DRAFT_PROFILE_EXCLUDED].sort()).toEqual([
      "bulk_unsubscribe", "create_filter", "forward_email", "reply_email", "send_draft", "send_email",
      "send_template", "set_signature", "set_vacation", "unsubscribe",
    ]);
  });

  it("refuses calls to hidden tools with an error naming the profile", async () => {
    process.env.MAILBOX_MCP_PROFILE = "read";
    const draft = await handleToolCall("create_draft", { account: "personal", to: ["a@example.net"], subject: "s", body: "b" }, ctx);
    expect(draft.isError).toBe(true);
    expect(draft.content[0].text).toMatch(/MAILBOX_MCP_PROFILE="read"/);
    expect(ctx.getProvider).not.toHaveBeenCalled();

    process.env.MAILBOX_MCP_PROFILE = "draft";
    for (const tool of ["send_email", "send_draft", "set_vacation", "unsubscribe"]) {
      const result = await handleToolCall(tool, { account: "personal" }, ctx);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0].text, tool).toMatch(/MAILBOX_MCP_PROFILE="draft"/);
    }
    expect(ctx.getProvider).not.toHaveBeenCalled();
  });

  it("still routes calls to tools the profile allows", async () => {
    process.env.MAILBOX_MCP_PROFILE = "read";
    const result = await handleToolCall("list_accounts", {}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No accounts configured");
  });

  it("composes with MAILBOX_MCP_TOOLS: both must allow a tool", async () => {
    process.env.MAILBOX_MCP_PROFILE = "draft";
    process.env.MAILBOX_MCP_TOOLS = "core";
    const listed = names();
    const core = Object.entries(TOOL_GROUPS).filter(([, g]) => g === "core").map(([n]) => n);
    expect(listed.sort()).toEqual(core.filter((n) => !DRAFT_PROFILE_EXCLUDED.has(n)).sort());
    expect(listed).toContain("search_emails");
    expect(listed).not.toContain("send_email");
    expect(listed).not.toContain("bulk_trash");

    const byGroup = await handleToolCall("bulk_trash", { account: "personal", query: "x" }, ctx);
    expect(byGroup.content[0].text).toContain("MAILBOX_MCP_TOOLS");
    const byProfile = await handleToolCall("send_email", { account: "personal" }, ctx);
    expect(byProfile.content[0].text).toContain("MAILBOX_MCP_PROFILE");
  });
});
