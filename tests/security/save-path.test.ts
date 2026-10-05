import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInsideProtectedDir, pathIsInside, protectedDirs, saveFile, validateSavePath } from "../../src/security/save-path.js";
import { loadAttachmentFromPath } from "../../src/security/attachment-loader.js";
import { handleToolCall, type ToolContextInput } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import "../../src/tools/export.js";
import "../../src/tools/attachments.js";

// Config and log directories placed under /tmp, which the save allowlist
// would otherwise accept, so the protection is what stops the write.
let configDir: string;
let logDir: string;
let plain: string;

// APFS and NTFS fold case; a path typed in the wrong case must still count
// as the same directory. Detected rather than assumed from the platform.
const caseInsensitive = () => existsSync(plain.toUpperCase());
const swapCase = (p: string) => p.replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/^\/PRIVATE\/TMP/, "/private/TMP");

beforeEach(() => {
  configDir = mkdtempSync("/tmp/mbx-protect-cfg-");
  logDir = mkdtempSync("/tmp/mbx-protect-log-");
  plain = mkdtempSync("/tmp/mbx-protect-plain-");
  process.env.MAILBOX_MCP_CONFIG_DIR = configDir;
  process.env.MAILBOX_MCP_LOG_DIR = logDir;
});

afterEach(() => {
  delete process.env.MAILBOX_MCP_CONFIG_DIR;
  delete process.env.MAILBOX_MCP_LOG_DIR;
  for (const d of [configDir, logDir, plain]) rmSync(d, { recursive: true, force: true });
});

describe("nothing the model calls may write into the config or log directory", () => {
  it("validateSavePath refuses the config dir, the log dir, their subdirectories and symlinks into them", () => {
    for (const dir of [configDir, join(configDir, "pending"), join(configDir, "accounts", "x"), logDir, join(logDir, "sub")]) {
      expect(() => validateSavePath(dir), dir).toThrow(/inside the mailbox-mcp config or log directory/);
    }
    const link = join(plain, "innocent");
    symlinkSync(configDir, link);
    expect(() => validateSavePath(join(link, "pending"))).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(validateSavePath(plain)).toBe(realpathSync.native(plain));
    expect(validateSavePath(join(plain, "new", "deeper"))).toBe(join(realpathSync.native(plain), "new", "deeper"));
  });

  it("a differently cased spelling of a protected directory is still protected (case-insensitive filesystems)", () => {
    if (!caseInsensitive()) return;
    const variant = swapCase(configDir);
    expect(variant).not.toBe(configDir);
    expect(existsSync(variant)).toBe(true);
    expect(pathIsInside(variant, configDir)).toBe(true);
    expect(pathIsInside(join(variant, "pending"), configDir)).toBe(true);
    expect(isInsideProtectedDir(join(variant, "accounts.json"))).toBe(true);
    expect(() => validateSavePath(variant)).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(() => validateSavePath(join(variant, "pending"))).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(() => validateSavePath(join(swapCase(logDir), "x"))).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(validateSavePath(swapCase(plain))).toBe(realpathSync.native(plain));
  });

  it("pathIsInside tells siblings and prefixes apart and follows symlinks by inode", () => {
    expect(pathIsInside(join(plain, "x", "y"), plain)).toBe(true);
    expect(pathIsInside(plain, plain)).toBe(true);
    expect(pathIsInside(plain + "x", plain)).toBe(false);
    expect(pathIsInside(join(plain, ".."), plain)).toBe(false);
    const nested = join(plain, "nested");
    mkdirSync(nested);
    const link = join(plain, "alias");
    symlinkSync(nested, link);
    expect(pathIsInside(join(link, "file"), nested)).toBe(true);
    expect(statSync(nested).ino).toBe(statSync(link).ino);
  });

  it("the default directories are protected when the variables are unset", () => {
    delete process.env.MAILBOX_MCP_CONFIG_DIR;
    delete process.env.MAILBOX_MCP_LOG_DIR;
    const [cfg, log] = protectedDirs();
    expect(cfg).toMatch(/\.mailbox-mcp$/);
    expect(log).toBe(cfg);
    expect(isInsideProtectedDir(join(cfg, "accounts.json"))).toBe(true);
    expect(isInsideProtectedDir(cfg + "-other")).toBe(false);
  });

  it("outgoing attachments cannot be read from the config or log directory, in any spelling", () => {
    mkdirSync(join(configDir, "accounts", "work"), { recursive: true });
    const secret = join(configDir, "accounts", "work", "token.json");
    writeFileSync(secret, "{}");
    writeFileSync(join(logDir, "sends.jsonl"), "");
    const ok = join(plain, "report.pdf");
    writeFileSync(ok, "%PDF-1.4");
    expect(() => loadAttachmentFromPath(secret)).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(() => loadAttachmentFromPath(join(logDir, "sends.jsonl"))).toThrow(/inside the mailbox-mcp config or log directory/);
    const link = join(plain, "looks-fine.json");
    symlinkSync(secret, link);
    expect(() => loadAttachmentFromPath(link)).toThrow(/inside the mailbox-mcp config or log directory/);
    if (caseInsensitive()) {
      expect(() => loadAttachmentFromPath(swapCase(secret))).toThrow(/inside the mailbox-mcp config or log directory/);
    }
    expect(loadAttachmentFromPath(ok).filename).toBe("report.pdf");
  });
});

describe("saveFile writes only to the canonical directory it validated", () => {
  it("creates the directory, returns the canonical path and writes 0600", () => {
    const target = join(plain, "new", "deeper");
    const out = saveFile(target, "message.eml", Buffer.from("raw"));
    expect(out).toBe(join(realpathSync.native(plain), "new", "deeper", "message.eml"));
    expect(readFileSync(out, "utf-8")).toBe("raw");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(saveFile(target, "message.eml", Buffer.from("again"))).toBe(out);
    expect(readFileSync(out, "utf-8")).toBe("again");
    if (caseInsensitive()) {
      expect(saveFile(swapCase(target), "other.eml", Buffer.from("x"))).toBe(join(realpathSync.native(plain), "new", "deeper", "other.eml"));
    }
  });

  it("uses only the basename and refuses empty or dot names", () => {
    const out = saveFile(plain, "../../escape.eml", Buffer.from("x"));
    expect(out).toBe(join(realpathSync.native(plain), "escape.eml"));
    for (const bad of ["", ".", "..", "/"]) {
      expect(() => saveFile(plain, bad, Buffer.from("x")), JSON.stringify(bad)).toThrow(/Refusing to save a file named/);
    }
  });

  it("refuses to write through a symlink planted under the final name", () => {
    const victim = join(configDir, "accounts.json");
    writeFileSync(victim, "{\"accounts\":{}}");
    symlinkSync(victim, join(plain, "innocent.eml"));
    expect(() => saveFile(plain, "innocent.eml", Buffer.from("{\"accounts\":{\"x\":{}}}"))).toThrow(/config or log directory/);
    expect(readFileSync(victim, "utf-8")).toBe("{\"accounts\":{}}");
    expect(lstatSync(join(plain, "innocent.eml")).isSymbolicLink()).toBe(true);

    const elsewhere = join(plain, "elsewhere.txt");
    writeFileSync(elsewhere, "keep");
    symlinkSync(elsewhere, join(plain, "link.eml"));
    expect(() => saveFile(plain, "link.eml", Buffer.from("overwrite"))).toThrow(/symlink/);
    expect(readFileSync(elsewhere, "utf-8")).toBe("keep");
  });

  it("refuses when a directory component is a symlink into a protected directory", () => {
    symlinkSync(configDir, join(plain, "detour"));
    expect(() => saveFile(join(plain, "detour", "pending"), "deadbeef.json", Buffer.from("{}"))).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(existsSync(join(configDir, "pending"))).toBe(false);
  });

  it("re-validates after creating the directory, so a component swapped for a symlink in between is caught", () => {
    const target = join(plain, "swap", "out");
    const swapIn = () => {
      rmSync(target, { recursive: true, force: true });
      symlinkSync(configDir, target);
    };
    expect(() => saveFile(target, "x.eml", Buffer.from("x"), swapIn)).toThrow(/inside the mailbox-mcp config or log directory/);
    expect(existsSync(join(configDir, "x.eml"))).toBe(false);
  });
});

describe("export and download tools go through saveFile", () => {
  function ctxWith(provider: Partial<MailProvider>): ToolContextInput {
    return {
      accountManager: { listAccounts: vi.fn(), getAccount: vi.fn().mockReturnValue({ provider: "gmail", email: "me@example.com" }) } as any,
      getProvider: vi.fn().mockReturnValue({ type: "gmail", capabilities: { threads: true, attachments: true }, ...provider }),
    };
  }

  it("export_email writes to the canonical directory and reports that path", async () => {
    const ctx = ctxWith({ exportMessage: vi.fn().mockResolvedValue({ filename: "m.eml", data: Buffer.from("raw"), mimeType: "message/rfc822" }) });
    const result = await handleToolCall("export_email", { account: "a", message_id: "m1", save_to: join(plain, "sub") }, ctx);
    expect(result.isError).toBeUndefined();
    const expected = join(realpathSync.native(plain), "sub", "m.eml");
    expect(result.content[0].text).toContain(expected);
    expect(readFileSync(expected, "utf-8")).toBe("raw");
  });

  it("export_thread writes every message through saveFile", async () => {
    const ctx = ctxWith({
      readThread: vi.fn().mockResolvedValue({ id: "t1", subject: "s", messages: [{ id: "m1" }, { id: "m2" }] }),
      exportMessage: vi.fn().mockImplementation(async (id: string) => ({ filename: `${id}.eml`, data: Buffer.from(id), mimeType: "message/rfc822" })),
    });
    const result = await handleToolCall("export_thread", { account: "a", thread_id: "t1", save_to: join(plain, "thread") }, ctx);
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(realpathSync.native(plain), "thread", "m2.eml"), "utf-8")).toBe("m2");
    const refused = await handleToolCall("export_thread", { account: "a", thread_id: "t1", save_to: join(configDir, "pending") }, ctx);
    expect(refused.isError).toBe(true);
    expect(existsSync(join(configDir, "pending"))).toBe(false);
  });

  it("download_attachment refuses a protected destination in any spelling and a symlinked filename", async () => {
    const ctx = ctxWith({ downloadAttachment: vi.fn().mockResolvedValue({ filename: "accounts.json", data: Buffer.from("{}"), mimeType: "application/json" }) });
    const dirs = [configDir, join(logDir, "x")];
    if (caseInsensitive()) dirs.push(swapCase(configDir));
    for (const dir of dirs) {
      const refused = await handleToolCall("download_attachment", { account: "a", message_id: "m1", attachment_id: "x", save_to: dir }, ctx);
      expect(refused.isError, dir).toBe(true);
      expect(refused.content[0].text, dir).toMatch(/config or log directory/);
    }
    expect(existsSync(join(configDir, "accounts.json"))).toBe(false);
    symlinkSync(join(configDir, "accounts.json"), join(plain, "accounts.json"));
    const viaLink = await handleToolCall("download_attachment", { account: "a", message_id: "m1", attachment_id: "x", save_to: plain }, ctx);
    expect(viaLink.isError).toBe(true);
    expect(viaLink.content[0].text).toMatch(/symlink|config or log directory/);
    expect(existsSync(join(configDir, "accounts.json"))).toBe(false);
  });
});
