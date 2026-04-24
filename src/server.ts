#!/usr/bin/env node

import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
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

// Lightweight lifecycle log so silent disconnects leave a paper trail.
// Lives in ~/.mailbox-mcp/debug.log with a 1MB rotation cap.
const LOG_DIR = join(homedir(), ".mailbox-mcp");
const LOG_PATH = join(LOG_DIR, "debug.log");
const LOG_MAX_BYTES = 1024 * 1024;

function logEvent(kind: string, detail: string = ""): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    try {
      if (statSync(LOG_PATH).size > LOG_MAX_BYTES) {
        renameSync(LOG_PATH, LOG_PATH + ".old");
      }
    } catch {}
    const line = `${new Date().toISOString()} pid=${process.pid} ${kind}${detail ? " " + redactTokens(detail) : ""}\n`;
    appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch {
    // Best-effort only — never let diagnostics crash the server.
  }
}

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

let requestCounter = 0;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const reqId = ++requestCounter;
  const startedAt = Date.now();
  logEvent("call-start", `req=${reqId} tool=${name}`);
  try {
    const result = await handleToolCall(name, (args ?? {}) as Record<string, unknown>, {
      accountManager,
      getProvider,
      clearProviderCache: (alias: string) => { providerCache.delete(alias); },
    });
    const ms = Date.now() - startedAt;
    const responseBytes = JSON.stringify(result).length;
    logEvent("call-end", `req=${reqId} tool=${name} ms=${ms} bytes=${responseBytes}`);
    return result;
  } catch (err: any) {
    const ms = Date.now() - startedAt;
    logEvent("call-error", `req=${reqId} tool=${name} ms=${ms} err=${String(err?.message ?? err)}`);
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
  const msg = redactTokens(String(err));
  console.error("Unhandled rejection (kept alive):", msg);
  logEvent("unhandledRejection", msg);
});
process.on("uncaughtException", (err) => {
  const msg = redactTokens(String(err));
  console.error("Uncaught exception (kept alive):", msg);
  logEvent("uncaughtException", msg);
});

// Record *why* the process exited so Jean can tell a clean shutdown apart
// from a client-initiated disconnect or an OOM kill.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"] as const) {
  process.on(sig, () => {
    logEvent("signal", sig);
    process.exit(0);
  });
}
process.on("exit", (code) => { logEvent("exit", `code=${code}`); });

// stdin EOF is how Claude Code tells the server "you're done". Log it so we
// can distinguish a clean client disconnect from a crash.
process.stdin.on("end", () => { logEvent("stdin-end"); });
process.stdin.on("error", (err) => { logEvent("stdin-error", String(err)); });
process.stdout.on("error", (err) => { logEvent("stdout-error", String(err)); });

async function main() {
  const transport = new StdioServerTransport();
  transport.onclose = () => { logEvent("transport-close"); };
  transport.onerror = (err: unknown) => { logEvent("transport-error", String(err)); };
  await server.connect(transport);
  logEvent("start", `version=${readPackageVersion()}`);
  console.error("mailbox-mcp server running on stdio");

  // Heartbeat: confirms the process is still alive after a silent client
  // disconnect. If the log shows heartbeats continuing past a request that the
  // client saw as "Connection closed", the server survived and the pipe was
  // torn down by the client (likely a request timeout). Unref so it doesn't
  // keep the event loop alive on its own.
  setInterval(() => { logEvent("alive"); }, 60_000).unref();
}

main().catch((err) => {
  const msg = redactTokens(String(err));
  console.error("Fatal:", msg);
  logEvent("fatal", msg);
  process.exit(1);
});
