import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureDir, secureWriteFile } from "./security/permissions.js";

export interface GmailAccountConfig {
  provider: "gmail";
  email: string;
}

export interface ImapAccountConfig {
  provider: "imap";
  email: string;
  host: string;
  port: number;
  smtpHost: string;
  smtpPort: number;
}

export interface JmapAccountConfig {
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

export class AccountManager {
  private configDir: string;
  private configPath: string;
  private data: AccountsFile;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(homedir(), ".mailbox-mcp");
    this.configPath = join(this.configDir, "accounts.json");
    ensureDir(this.configDir);
    this.data = this.load();
  }

  private load(): AccountsFile {
    if (!existsSync(this.configPath)) {
      return { accounts: {} };
    }
    const raw = readFileSync(this.configPath, "utf-8");
    return JSON.parse(raw) as AccountsFile;
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
