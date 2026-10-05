import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkOutgoing, isAllowedRecipient, DEFAULT_DAILY_SEND_LIMIT } from "../../src/security/send-guard.js";
import { recordSend, sendsInLastDay, hasSentTo } from "../../src/sendlog.js";
import type { MailProvider } from "../../src/providers/interface.js";
import type { AccountConfig } from "../../src/accounts.js";

let logDir: string;
const account = "work";
const config: AccountConfig = { provider: "gmail", email: "me@example.com" };

function provider(corresponded = false): MailProvider {
  return { hasCorrespondedWith: vi.fn().mockResolvedValue(corresponded) } as unknown as MailProvider;
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "mbx-sendguard-"));
  process.env.MAILBOX_MCP_LOG_DIR = logDir;
});

afterEach(() => {
  delete process.env.MAILBOX_MCP_LOG_DIR;
  rmSync(logDir, { recursive: true, force: true });
});

describe("recipient allowlist", () => {
  it("matches exact addresses and @domain patterns, case-insensitively", () => {
    const list = ["bob@example.com", "@partner.example"];
    expect(isAllowedRecipient("Bob <BOB@example.com>", list)).toBe(true);
    expect(isAllowedRecipient("anyone@Partner.example", list)).toBe(true);
    expect(isAllowedRecipient("anyone@sub.partner.example", list)).toBe(false);
    expect(isAllowedRecipient("bob@example.com.attacker.example", list)).toBe(false);
    expect(isAllowedRecipient("alice@example.com", list)).toBe(false);
  });

  it("refuses sends outside the allowlist and names the blocked addresses", async () => {
    const err = await checkOutgoing({
      account, config: { ...config, allowedRecipients: ["@example.com"] }, provider: provider(true),
      recipients: ["ok@example.com", "leak@attacker.example"], confirmNewRecipient: true,
    });
    expect(err).toMatch(/Refused/);
    expect(err).toContain("leak@attacker.example");
    expect(err).not.toContain("ok@example.com,");
  });

  it("applies the allowlist to drafts too", async () => {
    const err = await checkOutgoing({
      account, config: { ...config, allowedRecipients: ["@example.com"] }, provider: provider(true),
      recipients: ["leak@attacker.example"], draftOnly: true,
    });
    expect(err).toMatch(/allowlist/);
  });

  it("lets allowed recipients through", async () => {
    const err = await checkOutgoing({
      account, config: { ...config, allowedRecipients: ["@example.com"] }, provider: provider(true),
      recipients: ["ok@example.com"], confirmNewRecipient: true,
    });
    expect(err).toBeNull();
  });
});

describe("new-recipient check", () => {
  it("refuses a never-seen address without confirmation and lists it", async () => {
    const err = await checkOutgoing({ account, config, provider: provider(false), recipients: ["new@example.net"] });
    expect(err).toMatch(/never sent to or received from: new@example.net/);
    expect(err).toContain("confirm_new_recipient");
  });

  it("passes with confirm_new_recipient and does not consult the provider", async () => {
    const p = provider(false);
    const err = await checkOutgoing({ account, config, provider: p, recipients: ["new@example.net"], confirmNewRecipient: true });
    expect(err).toBeNull();
    expect(p.hasCorrespondedWith).not.toHaveBeenCalled();
  });

  it("treats addresses the provider has corresponded with as known", async () => {
    const p = provider(true);
    const err = await checkOutgoing({ account, config, provider: p, recipients: ["Old Friend <old@example.net>"] });
    expect(err).toBeNull();
    expect(p.hasCorrespondedWith).toHaveBeenCalledWith("old@example.net");
  });

  it("treats addresses in the local send log as known", async () => {
    recordSend(account, "send_email", ["Someone <prev@example.net>"]);
    const err = await checkOutgoing({ account, config, provider: provider(false), recipients: ["prev@example.net"] });
    expect(err).toBeNull();
  });

  it("does not let one account's send log vouch for another account", async () => {
    recordSend("other", "send_email", ["prev@example.net"]);
    const err = await checkOutgoing({ account, config, provider: provider(false), recipients: ["prev@example.net"] });
    expect(err).toMatch(/never sent to/);
  });

  it("treats the account's own address and explicitly known recipients as known", async () => {
    const err = await checkOutgoing({
      account, config, provider: provider(false),
      recipients: ["me@example.com", "sender@example.net"], knownRecipients: ["Sender <sender@example.net>"],
    });
    expect(err).toBeNull();
  });

  it("treats a provider lookup failure as unknown", async () => {
    const p = { hasCorrespondedWith: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as MailProvider;
    const err = await checkOutgoing({ account, config, provider: p, recipients: ["x@example.net"] });
    expect(err).toMatch(/never sent to/);
  });

  it("treats every address as new when the provider cannot search", async () => {
    const err = await checkOutgoing({ account, config, provider: {} as MailProvider, recipients: ["x@example.net"] });
    expect(err).toMatch(/never sent to/);
  });

  it("skips the check in draft mode", async () => {
    const err = await checkOutgoing({ account, config, provider: provider(false), recipients: ["x@example.net"], draftOnly: true });
    expect(err).toBeNull();
  });
});

describe("external forward check", () => {
  it("refuses forwarding outside the account's domain without confirmation", async () => {
    const err = await checkOutgoing({
      account, config, provider: provider(true), recipients: ["colleague@example.com", "out@attacker.example"], isForward: true,
    });
    expect(err).toContain("out@attacker.example");
    expect(err).toContain("confirm_external_forward");
    expect(err).not.toMatch(/colleague@example.com[^,]*confirm_external_forward/);
  });

  it("allows same-domain forwards without the flag", async () => {
    const err = await checkOutgoing({ account, config, provider: provider(true), recipients: ["colleague@example.com"], isForward: true });
    expect(err).toBeNull();
  });

  it("passes with confirm_external_forward", async () => {
    const err = await checkOutgoing({
      account, config, provider: provider(true), recipients: ["out@attacker.example"], isForward: true, confirmExternalForward: true,
    });
    expect(err).toBeNull();
  });

  it("reports both missing confirmations in one error", async () => {
    const err = await checkOutgoing({ account, config, provider: provider(false), recipients: ["out@attacker.example"], isForward: true });
    expect(err).toContain("confirm_external_forward");
    expect(err).toContain("confirm_new_recipient");
  });
});

describe("daily send cap", () => {
  it("counts sends in a rolling 24h window from the persisted log", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(logDir, "sends.jsonl"), JSON.stringify({ ts: old, account, tool: "send_email", to: ["a@example.net"] }) + "\n");
    recordSend(account, "send_email", ["b@example.net"]);
    recordSend("other", "send_email", ["c@example.net"]);
    expect(sendsInLastDay(account)).toBe(1);
    expect(hasSentTo(account, "a@example.net")).toBe(true);
  });

  it("refuses once the account's limit is reached", async () => {
    for (let i = 0; i < 3; i++) recordSend(account, "send_email", ["x@example.net"]);
    const err = await checkOutgoing({ account, config: { ...config, dailySendLimit: 3 }, provider: provider(true), recipients: ["x@example.net"] });
    expect(err).toMatch(/Daily send limit reached: 3 messages/);
  });

  it("defaults to 100 per day", async () => {
    for (let i = 0; i < DEFAULT_DAILY_SEND_LIMIT; i++) recordSend(account, "send_email", ["x@example.net"]);
    const err = await checkOutgoing({ account, config, provider: provider(true), recipients: ["x@example.net"] });
    expect(err).toMatch(/limit 100/);
    expect(DEFAULT_DAILY_SEND_LIMIT).toBe(100);
  });

  it("survives a restart because the count lives on disk", () => {
    recordSend(account, "send_email", ["x@example.net"]);
    const raw = readFileSync(join(logDir, "sends.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw).to).toEqual(["x@example.net"]);
    expect(sendsInLastDay(account)).toBe(1);
  });

  it("ignores a torn line in the log", () => {
    writeFileSync(join(logDir, "sends.jsonl"), '{"ts":"20', "utf-8");
    recordSend(account, "send_email", ["x@example.net"]);
    expect(sendsInLastDay(account)).toBe(1);
  });
});
