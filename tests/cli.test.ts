import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hiddenCharacterCount, runCli, type Terminal } from "../src/cli.js";
import { AccountManager, type AccountConfig } from "../src/accounts.js";
import { pendingDir, queueSend, readPending, type PendingSend } from "../src/pending.js";
import { recordSend } from "../src/sendlog.js";
import type { MailProvider } from "../src/providers/interface.js";

let dir: string;
let provider: MailProvider;
let output: string[];
let terminal: Terminal & { write: ReturnType<typeof vi.fn>; readLine: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let openTerminal: ReturnType<typeof vi.fn>;

const print = (line: string) => { output.push(line); };
const printed = () => output.join("\n");

function configure(config: Partial<AccountConfig> = {}): void {
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: { personal: { provider: "gmail", email: "me@example.com", approval: "external", ...config } } }));
}

const base = {
  account: "personal", tool: "send_email", reason: "approval" as const, action: { kind: "send" as const },
  from: "alias@example.com", to: ["a@example.net"], cc: ["c@example.net"], bcc: [], subject: "Quarterly numbers", body: "Line one\nLine two", html: false, attachments: [],
};

const draftSpec = { ...base, tool: "send_draft", action: { kind: "sendDraft" as const, draftId: "d1", fingerprint: "fp-1" }, to: ["t@example.net"], cc: [], subject: "", body: "" };

function run(argv: string[], overrides: { terminal?: Terminal; now?: number } = {}) {
  return runCli(argv, {
    openTerminal: overrides.terminal ? () => overrides.terminal! : openTerminal,
    getProvider: async () => provider,
    print,
    now: overrides.now ? () => overrides.now! : undefined,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mbx-cli-"));
  process.env.MAILBOX_MCP_CONFIG_DIR = dir;
  process.env.MAILBOX_MCP_LOG_DIR = dir;
  configure();
  output = [];
  provider = {
    sendMessage: vi.fn().mockResolvedValue("sent-1"),
    replyToMessage: vi.fn().mockResolvedValue("reply-1"),
    forwardMessage: vi.fn().mockResolvedValue("fwd-1"),
    sendDraft: vi.fn().mockResolvedValue("draft-sent-1"),
    hasCorrespondedWith: vi.fn().mockResolvedValue(true),
    draftFingerprint: vi.fn().mockResolvedValue("fp-1"),
    getDraftRecipients: vi.fn().mockResolvedValue(["t@example.net"]),
  } as unknown as MailProvider;
  terminal = { write: vi.fn(), readLine: vi.fn().mockReturnValue("yes"), close: vi.fn() };
  openTerminal = vi.fn().mockReturnValue(terminal);
});

afterEach(() => {
  delete process.env.MAILBOX_MCP_CONFIG_DIR;
  delete process.env.MAILBOX_MCP_LOG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => vi.mocked(provider.sendMessage).mock.calls.length + vi.mocked(provider.replyToMessage).mock.calls.length
  + vi.mocked(provider.forwardMessage).mock.calls.length + vi.mocked(provider.sendDraft).mock.calls.length;

describe("mailbox-mcp approve", () => {
  it("refuses when no terminal can be opened, and sends nothing", async () => {
    const spec = queueSend(base);
    openTerminal.mockImplementation(() => { throw new Error("approve needs an interactive terminal and /dev/tty could not be opened (ENXIO). Run it yourself in a terminal; it is deliberately impossible from a non-interactive shell."); });
    const code = await run(["approve", spec.id]);
    expect(code).toBe(1);
    expect(printed()).toMatch(/Not sent: approve needs an interactive terminal/);
    expect(sent()).toBe(0);
    expect(readPending(spec.id)).toBeDefined();
    expect(existsSync(join(dir, "sends.jsonl"))).toBe(false);
  });

  it("prints the whole message, sends exactly that on yes, records it and removes the file", async () => {
    const attachment = join(dir, "report.pdf");
    writeFileSync(attachment, "%PDF-1.4 hello");
    const spec = queueSend({ ...base, attachments: [{ path: attachment, name: "report.pdf", size: 14 }] });
    const code = await run(["approve", spec.id]);
    expect(code).toBe(0);

    const text = printed();
    for (const expected of ["personal", "alias@example.com", "a@example.net", "c@example.net", "Quarterly numbers", "Line one", "Line two", "report.pdf (14 bytes)", "Sent. Message ID: sent-1"]) {
      expect(text).toContain(expected);
    }
    expect(terminal.write).toHaveBeenCalledWith(expect.stringMatching(/Type yes to send/));
    expect(terminal.close).toHaveBeenCalled();

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const [to, subject, body, options] = vi.mocked(provider.sendMessage).mock.calls[0];
    expect(to).toEqual(["a@example.net"]);
    expect(subject).toBe("Quarterly numbers");
    expect(body).toBe("Line one\nLine two");
    expect(options).toMatchObject({ from: "alias@example.com", cc: ["c@example.net"], bcc: undefined, html: false });
    expect(options!.attachments).toHaveLength(1);
    expect(options!.attachments![0].filename).toBe("report.pdf");
    expect(options!.attachments![0].data.toString()).toBe("%PDF-1.4 hello");

    const log = readFileSync(join(dir, "sends.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toEqual([expect.objectContaining({ account: "personal", tool: "send_email", to: ["a@example.net", "c@example.net"] })]);
    expect(readPending(spec.id)).toBeUndefined();
  });

  it("sends nothing unless the answer is exactly yes", async () => {
    for (const answer of ["y", "Yes please", "", "no"]) {
      const spec = queueSend(base);
      terminal.readLine.mockReturnValueOnce(answer);
      expect(await run(["approve", spec.id]), answer).toBe(1);
      expect(readPending(spec.id), answer).toBeDefined();
    }
    expect(sent()).toBe(0);
    expect(printed()).toMatch(/Not sent\. The message stays in the queue\./);
  });

  it("refuses an expired entry before even asking", async () => {
    const spec = queueSend(base);
    const code = await run(["approve", spec.id], { now: Date.parse(spec.createdAt) + 8 * 24 * 60 * 60 * 1000 });
    expect(code).toBe(1);
    expect(printed()).toMatch(/expired/);
    expect(openTerminal).not.toHaveBeenCalled();
    expect(sent()).toBe(0);
    expect(readPending(spec.id)).toBeDefined();
  });

  it("refuses a message carrying terminal escapes, bidi overrides or zero-width characters", async () => {
    const cases: Array<[string, Partial<typeof base>]> = [
      ["ANSI escape in the body", { body: "Pay \u001b[2K\u001b[1Ginvoice to the usual account" }],
      ["bidi override in the subject", { subject: "Re: ‮invoice" }],
      ["zero-width space in a recipient", { to: ["a​@example.net"] }],
      ["control char in from", { from: "al\u0007ias@example.com" }],
    ];
    for (const [name, overrides] of cases) {
      const spec = queueSend({ ...base, ...overrides });
      expect(hiddenCharacterCount(spec), name).toBeGreaterThan(0);
      expect(await run(["approve", spec.id]), name).toBe(1);
      expect(printed(), name).toMatch(/control, bidirectional or zero-width characters/);
      expect(printed(), name).not.toContain("\u001b");
      expect(readPending(spec.id), name).toBeDefined();
      output = [];
    }
    expect(openTerminal).not.toHaveBeenCalled();
    expect(sent()).toBe(0);
    expect(hiddenCharacterCount({ ...base, id: "x", createdAt: "" } as PendingSend)).toBe(0);
  });

  it("refuses when the pending file changed between display and send", async () => {
    const spec = queueSend(base);
    terminal.readLine.mockImplementation(() => {
      writeFileSync(join(pendingDir(), `${spec.id}.json`), JSON.stringify({ ...spec, to: ["attacker@example.net"] }));
      return "yes";
    });
    expect(await run(["approve", spec.id])).toBe(1);
    expect(printed()).toMatch(/changed or disappeared while you were approving/);
    expect(sent()).toBe(0);
  });

  it("refuses a pending entry that is a symlink", async () => {
    const outside = join(dir, "outside.json");
    writeFileSync(outside, JSON.stringify({ ...base, id: "abcdef01", createdAt: new Date().toISOString() }));
    const spec = queueSend(base);
    symlinkSync(outside, join(pendingDir(), "abcdef01.json"));
    expect(await run(["approve", "abcdef01"])).toBe(1);
    expect(printed()).toMatch(/ELOOP|symbolic|symlink/i);
    expect(sent()).toBe(0);
    expect(readPending(spec.id)).toBeDefined();
  });

  it("re-runs the allowlist with today's accounts.json", async () => {
    const spec = queueSend(base);
    configure({ allowedRecipients: ["@example.com"] });
    expect(await run(["approve", spec.id])).toBe(1);
    expect(printed()).toMatch(/allowlist/);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(sent()).toBe(0);
  });

  it("re-runs the daily cap", async () => {
    const spec = queueSend(base);
    configure({ dailySendLimit: 1 });
    recordSend("personal", "send_email", ["x@example.net"]);
    expect(await run(["approve", spec.id])).toBe(1);
    expect(printed()).toMatch(/Daily send limit reached/);
    expect(sent()).toBe(0);
  });

  it("refuses if the account became read-only or draftsOnly since", async () => {
    const a = queueSend(base);
    configure({ readOnly: true });
    expect(await run(["approve", a.id])).toBe(1);
    expect(printed()).toMatch(/read-only/);
    const b = queueSend(base);
    configure({ draftsOnly: true });
    expect(await run(["approve", b.id])).toBe(1);
    expect(printed()).toMatch(/draftsOnly/);
    expect(sent()).toBe(0);
  });

  it("revalidates attachments and refuses when one changed size or vanished", async () => {
    const attachment = join(dir, "report.pdf");
    writeFileSync(attachment, "%PDF-1.4 hello");
    const changed = queueSend({ ...base, attachments: [{ path: attachment, name: "report.pdf", size: 14 }] });
    writeFileSync(attachment, "%PDF-1.4 hello, now with more bytes");
    expect(await run(["approve", changed.id])).toBe(1);
    expect(printed()).toMatch(/changed since it was queued \(14 bytes then, 35 now\)/);

    const gone = queueSend({ ...base, attachments: [{ path: attachment, name: "report.pdf", size: 35 }] });
    unlinkSync(attachment);
    expect(await run(["approve", gone.id])).toBe(1);
    expect(printed()).toMatch(/Attachment not found/);
    expect(sent()).toBe(0);
    expect(readPending(changed.id)).toBeDefined();
    expect(readPending(gone.id)).toBeDefined();
  });

  it("replays reply, forward and draft sends through the matching provider call", async () => {
    const reply = queueSend({ ...base, tool: "reply_email", action: { kind: "reply", messageId: "m1", replyAll: true }, to: ["Sender <s@example.net>"], cc: [] });
    const forward = queueSend({ ...base, tool: "forward_email", action: { kind: "forward", messageId: "m2" }, to: ["o@example.com"], cc: [], body: "FYI" });
    const draft = queueSend(draftSpec);
    for (const spec of [reply, forward, draft]) expect(await run(["approve", spec.id]), spec.tool).toBe(0);

    expect(provider.replyToMessage).toHaveBeenCalledWith("m1", "Line one\nLine two", expect.objectContaining({ from: "alias@example.com", replyAll: true }));
    expect(provider.forwardMessage).toHaveBeenCalledWith("m2", ["o@example.com"], expect.objectContaining({ message: "FYI" }));
    expect(provider.sendDraft).toHaveBeenCalledWith("d1");
    expect(provider.sendMessage).not.toHaveBeenCalled();
    const log = readFileSync(join(dir, "sends.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l).tool);
    expect(log).toEqual(["reply_email", "forward_email", "send_draft"]);
    expect(printed()).toMatch(/Sends draft d1 exactly as it was when queued/);
  });

  it("refuses a queued send_draft whose draft changed or gained recipients since", async () => {
    const edited = queueSend(draftSpec);
    vi.mocked(provider.draftFingerprint!).mockResolvedValueOnce("fp-2");
    expect(await run(["approve", edited.id])).toBe(1);
    expect(printed()).toMatch(/draft d1 changed since it was queued/);

    const widened = queueSend(draftSpec);
    vi.mocked(provider.getDraftRecipients!).mockResolvedValueOnce(["t@example.net", "attacker@example.net"]);
    expect(await run(["approve", widened.id])).toBe(1);
    expect(printed()).toMatch(/different recipients than when it was queued/);

    delete (provider as any).draftFingerprint;
    const blind = queueSend(draftSpec);
    expect(await run(["approve", blind.id])).toBe(1);
    expect(printed()).toMatch(/cannot verify that the draft is unchanged/);

    expect(provider.sendDraft).not.toHaveBeenCalled();
    expect(terminal.readLine).not.toHaveBeenCalled();
  });

  it("keeps the file when the provider fails to send", async () => {
    const spec = queueSend(base);
    vi.mocked(provider.sendMessage).mockRejectedValueOnce(new Error("SMTP 550"));
    expect(await run(["approve", spec.id])).toBe(1);
    expect(printed()).toMatch(/Send failed: SMTP 550/);
    expect(readPending(spec.id)).toBeDefined();
    expect(existsSync(join(dir, "sends.jsonl"))).toBe(false);
  });

  it("refuses an unknown account or id", async () => {
    const spec = queueSend({ ...base, account: "ghost" });
    expect(await run(["approve", spec.id])).toBe(1);
    expect(printed()).toMatch(/Account "ghost" not found/);
    expect(await run(["approve", "deadbeef"])).toBe(1);
    expect(printed()).toMatch(/No pending send with id deadbeef/);
  });
});

describe("mailbox-mcp pending / show / reject", () => {
  it("pending lists id, account, from, recipients, subject, created and attachment names", async () => {
    const spec = queueSend({ ...base, bcc: ["hidden@example.net"], attachments: [{ path: "/tmp/x/report.pdf", name: "report.pdf", size: 10 }] });
    expect(await run(["pending"])).toBe(0);
    const text = printed();
    for (const expected of [spec.id, "personal", "send_email", spec.createdAt, "alias@example.com", "a@example.net", "c@example.net", "hidden@example.net", "Quarterly numbers", "report.pdf"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("Line one");
  });

  it("pending says so when the queue is empty", async () => {
    expect(await run(["pending"])).toBe(0);
    expect(printed()).toBe("No sends waiting for approval.");
  });

  it("show prints the full body", async () => {
    const spec = queueSend(base);
    expect(await run(["show", spec.id])).toBe(0);
    expect(printed()).toContain("Line one");
    expect(printed()).toContain("Line two");
  });

  it("reject removes the entry without sending", async () => {
    const spec = queueSend(base);
    expect(await run(["reject", spec.id])).toBe(0);
    expect(printed()).toMatch(/Rejected .* Nothing was sent/);
    expect(readPending(spec.id)).toBeUndefined();
    expect(sent()).toBe(0);
  });

  it("rejects unknown commands and missing ids with usage", async () => {
    expect(await run(["bogus"])).toBe(2);
    expect(printed()).toMatch(/Unknown command "bogus"/);
    expect(printed()).toMatch(/mailbox-mcp approve <id>/);
    output = [];
    expect(await run(["approve"])).toBe(2);
    expect(printed()).toMatch(/approve needs a pending id/);
  });

  it("rejects an id that is not eight hex characters", async () => {
    expect(await run(["show", "../etc"])).toBe(1);
    expect(printed()).toMatch(/Invalid pending id/);
  });
});

describe("the queue only ever lives in the config directory", () => {
  it("uses MAILBOX_MCP_CONFIG_DIR, the same directory AccountManager reads", () => {
    expect(pendingDir()).toBe(join(new AccountManager().getConfigDir(), "pending"));
  });

  it("the stored spec is plain JSON a person can read", () => {
    const spec = queueSend(base);
    const raw = JSON.parse(readFileSync(join(pendingDir(), `${spec.id}.json`), "utf-8")) as PendingSend;
    expect(raw.body).toBe("Line one\nLine two");
  });
});
