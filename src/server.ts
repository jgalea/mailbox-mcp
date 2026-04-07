#!/usr/bin/env node

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

const server = new Server(
  { name: "mailbox-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const accountManager = new AccountManager();
const providerCache = new Map<string, MailProvider>();

async function getProvider(alias: string): Promise<MailProvider> {
  const cached = providerCache.get(alias);
  if (cached) return cached;

  const config = accountManager.getAccount(alias);

  if (config.provider === "gmail") {
    const configDir = accountManager.getAccountDir(alias).replace(/\/accounts\/.*/, "");
    const gmail = getGmailClient(configDir, alias);
    const provider = new GmailProvider(gmail);
    providerCache.set(alias, provider);
    return provider;
  }

  if (config.provider === "imap") {
    // Dynamic imports to avoid loading IMAP deps for Gmail-only users
    const { ImapFlow } = await import("imapflow");
    const { createTransport } = await import("nodemailer");
    const { decryptCredentials } = await import("./auth/imap-auth.js");

    const configDir = accountManager.getAccountDir(alias).replace(/\/accounts\/.*/, "");
    const passphrase = process.env.MAILBOX_MCP_PASSPHRASE ?? "";
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
    const configDir = accountManager.getAccountDir(alias).replace(/\/accounts\/.*/, "");
    const passphrase = process.env.MAILBOX_MCP_PASSPHRASE ?? "";
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
  return handleToolCall(name, (args ?? {}) as Record<string, unknown>, {
    accountManager,
    getProvider,
    clearProviderCache: (alias: string) => { providerCache.delete(alias); },
  });
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
