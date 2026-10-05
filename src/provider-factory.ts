import type { AccountConfig } from "./accounts.js";
import type { MailProvider } from "./providers/interface.js";
import { GmailProvider } from "./providers/gmail.js";
import { getGmailClient } from "./auth/gmail-oauth.js";
import { redactTokens } from "./security/sanitize.js";

export interface ProviderHooks {
  /** IMAP connections time out after ~30 min idle and emit `close`; the server uses this to evict its cache. */
  onImapClose?: () => void;
}

// Builds a connected provider for one account. Shared by the MCP server and
// the approve CLI so both send through exactly the same code.
export async function createProvider(alias: string, config: AccountConfig, configDir: string, hooks: ProviderHooks = {}): Promise<MailProvider> {
  if (config.provider === "gmail") {
    const gmail = await getGmailClient(configDir, alias);
    return new GmailProvider(gmail);
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

    imap.on("close", () => { hooks.onImapClose?.(); });
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
    return new ImapProvider(imap, smtp, config.email);
  }

  if (config.provider === "jmap") {
    const { decryptJmapCredentials } = await import("./auth/jmap-auth.js");
    const passphrase = process.env.MAILBOX_MCP_PASSPHRASE;
    if (!passphrase) {
      throw new Error(`JMAP account "${alias}" requires MAILBOX_MCP_PASSPHRASE to decrypt credentials. Set it in your MCP server environment.`);
    }
    const creds = decryptJmapCredentials(configDir, alias, passphrase);

    const { JmapProvider } = await import("./providers/jmap.js");
    return new JmapProvider(
      config.host,
      config.email,
      creds.username,
      creds.password,
      config.sessionUrl,
    );
  }

  throw new Error(`Unknown provider type: "${(config as any).provider}"`);
}
