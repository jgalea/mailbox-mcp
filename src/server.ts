#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AccountManager } from "./accounts.js";
import { GmailProvider } from "./providers/gmail.js";
import { getAllToolDefinitions, handleToolCall } from "./tools/registry.js";
import type { MailProvider } from "./providers/interface.js";
import { getGmailClient } from "./auth/gmail-oauth.js";
import { redactTokens } from "./security/sanitize.js";

// Import tool registrations (side-effect: registers tools)
import "./tools/account.js";
import "./tools/read.js";
import "./tools/write.js";
import "./tools/manage.js";
import "./tools/gmail-only.js";
import "./tools/attachments.js";
import "./tools/actions.js";
import "./tools/export.js";

function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new Server(
  { name: "mailbox-mcp", version: readPackageVersion() },
  { capabilities: { tools: {} } }
);

const accountManager = new AccountManager();
const providerCache = new Map<string, MailProvider>();

async function getProvider(alias: string): Promise<MailProvider> {
  const cached = providerCache.get(alias);
  if (cached) return cached;

  const config = accountManager.getAccount(alias);

  const configDir = accountManager.getConfigDir();

  if (config.provider === "gmail") {
    const gmail = await getGmailClient(configDir, alias);
    const provider = new GmailProvider(gmail);
    providerCache.set(alias, provider);
    return provider;
  }

  if (config.provider === "imap") {
    // Dynamic imports to avoid loading IMAP deps for Gmail-only users
    const { ImapFlow } = await import("imapflow");
    const { createTransport } = await import("nodemailer");
    const { decryptCredentials } = await import("./auth/imap-auth.js");

    const passphrase = process.env.MAILBOX_MCP_PASSPHRASE;
    if (!passphrase) {
      throw new Error(`IMAP account "${alias}" requires MAILBOX_MCP_PASSPHRASE to decrypt credentials. Set it in your MCP server environment.`);
    }
    const creds = decryptCredentials(configDir, alias, passphrase);

    const imap = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      tls: { rejectUnauthorized: true },
      auth: { user: creds.username, pass: creds.password },
      logger: false,
    });
    await imap.connect();

    // IMAP connections time out after ~30 min of idle and emit `close`.
    // Evict the cached provider so the next tool call opens a fresh connection.
    imap.on("close", () => {
      if (providerCache.get(alias) === provider) {
        providerCache.delete(alias);
        console.error(`IMAP connection closed for "${alias}"; will reconnect on next request`);
      }
    });
    imap.on("error", (err: any) => {
      console.error(`IMAP error on "${alias}":`, redactTokens(String(err?.message ?? err)));
    });

    const smtp = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      auth: { user: creds.username, pass: creds.password },
    });

    const { ImapProvider } = await import("./providers/imap.js");
    const provider = new ImapProvider(imap, smtp, config.email);
    providerCache.set(alias, provider);
    return provider;
  }

  if (config.provider === "jmap") {
    const { decryptJmapCredentials } = await import("./auth/jmap-auth.js");
    const passphrase = process.env.MAILBOX_MCP_PASSPHRASE;
    if (!passphrase) {
      throw new Error(`JMAP account "${alias}" requires MAILBOX_MCP_PASSPHRASE to decrypt credentials. Set it in your MCP server environment.`);
    }
    const creds = decryptJmapCredentials(configDir, alias, passphrase);

    const { JmapProvider } = await import("./providers/jmap.js");
    const provider = new JmapProvider(
      config.host,
      config.email,
      creds.username,
      creds.password,
      config.sessionUrl,
    );
    providerCache.set(alias, provider);
    return provider;
  }

  throw new Error(`Unknown provider type: "${(config as any).provider}"`);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getAllToolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleToolCall(name, (args ?? {}) as Record<string, unknown>, {
      accountManager,
      getProvider,
      clearProviderCache: (alias: string) => { providerCache.delete(alias); },
    });
  } catch (err: any) {
    // Clear cached provider on auth/connection errors so next call reconnects
    const alias = (args as any)?.account;
    if (alias && isAuthOrConnectionError(err)) {
      providerCache.delete(alias);
      console.error(`Cleared provider cache for "${alias}" after auth/connection error`);
    }
    return { content: [{ type: "text" as const, text: `Error: ${redactTokens(String(err.message ?? err))}` }], isError: true };
  }
});

function isAuthOrConnectionError(err: any): boolean {
  const code = err?.code ?? err?.response?.status;
  if (code === 401 || code === 403) return true;
  const codeStr = typeof err?.code === "string" ? err.code : "";
  if (codeStr === "NoConnection" || codeStr === "ECONNRESET" || codeStr === "EPIPE") return true;
  const msg = String(err?.message ?? "");
  return msg.includes("invalid_grant")
    || msg.includes("Token has been expired")
    || msg.includes("Invalid Credentials");
}

// Prevent crashes from unhandled rejections (e.g. expired tokens, network errors)
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (kept alive):", redactTokens(String(err)));
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (kept alive):", redactTokens(String(err)));
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mailbox-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", redactTokens(String(err)));
  process.exit(1);
});
