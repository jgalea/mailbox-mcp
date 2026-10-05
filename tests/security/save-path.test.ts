import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInsideProtectedDir, protectedDirs, validateSavePath } from "../../src/security/save-path.js";
import { loadAttachmentFromPath } from "../../src/security/attachment-loader.js";

// Config and log directories placed under /tmp, which the save allowlist
// would otherwise accept, so the protection is what stops the write.
let configDir: string;
let logDir: string;
let plain: string;

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
    expect(() => validateSavePath(plain)).not.toThrow();
    expect(() => validateSavePath(join(plain, "new", "deeper"))).not.toThrow();
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

  it("outgoing attachments cannot be read from the config or log directory", () => {
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
    expect(loadAttachmentFromPath(ok).filename).toBe("report.pdf");
  });
});
