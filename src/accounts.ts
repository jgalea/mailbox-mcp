import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureDir, secureWriteFile } from "./security/permissions.js";

// Per-account safety settings. All optional; an account with none of them set
// behaves as before. They are read from accounts.json and can be set when the
// account is created, but no tool can loosen them afterwards: that takes an
// edit to the file, so a prompt-injected session cannot switch them off.
export interface AccountGuards {
  readOnly?: boolean;
  draftsOnly?: boolean;
  allowedRecipients?: string[];
  dailySendLimit?: number;
  /** "external": sends are queued to disk and only leave after `mailbox-mcp approve <id>` in a terminal. */
  approval?: "external";
  /** What happens to sends once this session has read mail from a sender the account never wrote to. */
  untrustedReadLock?: "approval" | "refuse";
}

export interface GmailAccountConfig extends AccountGuards {
  provider: "gmail";
  email: string;
}

export interface ImapAccountConfig extends AccountGuards {
  provider: "imap";
  email: string;
  host: string;
  port: number;
  smtpHost: string;
  smtpPort: number;
}

export interface JmapAccountConfig extends AccountGuards {
  provider: "jmap";
  email: string;
  host: string;
  sessionUrl?: string;
}

export type AccountConfig = GmailAccountConfig | ImapAccountConfig | JmapAccountConfig;

interface AccountsFile {
  accounts: Record<string, AccountConfig>;
}

const ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_RECIPIENT_PATTERN = /^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/i;

export function validateGuards(guards: AccountGuards): void {
  if (guards.allowedRecipients !== undefined) {
    if (!Array.isArray(guards.allowedRecipients)) {
      throw new Error("allowedRecipients must be an array of addresses or @domain patterns");
    }
    for (const entry of guards.allowedRecipients) {
      if (typeof entry !== "string" || !ALLOWED_RECIPIENT_PATTERN.test(entry.trim())) {
        throw new Error(`Invalid allowedRecipients entry "${entry}". Use an exact address (user@example.com) or a domain pattern (@example.com).`);
      }
    }
  }
  if (guards.dailySendLimit !== undefined) {
    if (!Number.isInteger(guards.dailySendLimit) || guards.dailySendLimit < 0) {
      throw new Error("dailySendLimit must be a non-negative integer");
    }
  }
  if (guards.approval !== undefined && guards.approval !== "external") {
    throw new Error(`approval must be "external" (got ${JSON.stringify(guards.approval)})`);
  }
  if (guards.untrustedReadLock !== undefined && guards.untrustedReadLock !== "approval" && guards.untrustedReadLock !== "refuse") {
    throw new Error(`untrustedReadLock must be "approval" or "refuse" (got ${JSON.stringify(guards.untrustedReadLock)})`);
  }
}

export class AccountManager {
  private configDir: string;
  private configPath: string;
  private data: AccountsFile;

  constructor(configDir?: string) {
    this.configDir = configDir ?? process.env.MAILBOX_MCP_CONFIG_DIR ?? join(homedir(), ".mailbox-mcp");
    this.configPath = join(this.configDir, "accounts.json");
    ensureDir(this.configDir);
    this.data = this.load();
  }

  private load(): AccountsFile {
    if (!existsSync(this.configPath)) {
      return { accounts: {} };
    }
    const raw = readFileSync(this.configPath, "utf-8");
    const parsed = JSON.parse(raw) as AccountsFile;
    for (const [alias, config] of Object.entries(parsed.accounts ?? {})) {
      try {
        validateGuards(config);
      } catch (err) {
        throw new Error(`accounts.json: account "${alias}": ${(err as Error).message}`);
      }
    }
    return parsed;
  }

  private save(): void {
    secureWriteFile(this.configPath, JSON.stringify(this.data, null, 2));
  }

  listAccounts(): Record<string, AccountConfig> {
    return { ...this.data.accounts };
  }

  getAccount(alias: string): AccountConfig {
    const account = this.data.accounts[alias];
    if (!account) {
      throw new Error(`Account "${alias}" not found`);
    }
    return account;
  }

  addAccount(alias: string, config: AccountConfig): void {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new Error(`Invalid alias "${alias}". Use only letters, numbers, hyphens, underscores.`);
    }
    if (this.data.accounts[alias]) {
      throw new Error(`Account "${alias}" already exists`);
    }
    validateGuards(config);
    this.data.accounts[alias] = config;
    ensureDir(join(this.configDir, "accounts", alias));
    this.save();
  }

  removeAccount(alias: string): void {
    if (!this.data.accounts[alias]) {
      throw new Error(`Account "${alias}" not found`);
    }
    delete this.data.accounts[alias];
    const accountDir = join(this.configDir, "accounts", alias);
    if (existsSync(accountDir)) {
      rmSync(accountDir, { recursive: true, force: true });
    }
    this.save();
  }

  getAccountDir(alias: string): string {
    return join(this.configDir, "accounts", alias);
  }

  getConfigDir(): string {
    return this.configDir;
  }
}
