import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleToolCall, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import "../../src/tools/write.js";

function createMockProvider(): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, snooze: true, templates: true, signatures: true, vacation: true, contacts: true, unsubscribe: true, attachments: true, inboxSummary: true },
    sendMessage: vi.fn().mockResolvedValue("sent-msg-1"),
    replyToMessage: vi.fn().mockResolvedValue("reply-msg-1"),
    forwardMessage: vi.fn().mockResolvedValue("fwd-msg-1"),
    createDraft: vi.fn().mockResolvedValue("draft-1"),
  } as unknown as MailProvider;
}

describe("write tools", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    mockProvider = createMockProvider();
    ctx = { accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any, getProvider: vi.fn().mockReturnValue(mockProvider) };
  });

  it("send_email sends and returns message ID", async () => {
    const result = await handleToolCall("send_email", { account: "personal", to: ["test@test.com"], subject: "Hi", body: "Hello" }, ctx);
    expect(result.content[0].text).toContain("sent-msg-1");
    expect(mockProvider.sendMessage).toHaveBeenCalledWith(["test@test.com"], "Hi", "Hello", expect.anything());
  });

  it("reply_email replies and returns message ID", async () => {
    const result = await handleToolCall("reply_email", { account: "personal", message_id: "msg-1", body: "Thanks" }, ctx);
    expect(result.content[0].text).toContain("reply-msg-1");
  });

  it("forward_email forwards and returns message ID", async () => {
    const result = await handleToolCall("forward_email", { account: "personal", message_id: "msg-1", to: ["other@test.com"] }, ctx);
    expect(result.content[0].text).toContain("fwd-msg-1");
  });

  it("create_draft creates and returns draft ID", async () => {
    const result = await handleToolCall("create_draft", { account: "personal", to: ["test@test.com"], subject: "Draft", body: "WIP" }, ctx);
    expect(result.content[0].text).toContain("draft-1");
  });
});
