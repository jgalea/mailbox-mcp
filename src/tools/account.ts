import { registerTool } from "./registry.js";
import { clearSendLimit } from "./write.js";

registerTool(
  {
    name: "list_accounts",
    description: "List all configured email accounts with their provider type and email address",
    inputSchema: { type: "object" as const, properties: {} },
  },
  async (_args, ctx) => {
    const accounts = ctx.accountManager.listAccounts();
    const entries = Object.entries(accounts);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No accounts configured. Use authenticate to add one." }] };
    }
    const lines = entries.map(([alias, config]) => `- **${alias}** (${config.provider}): ${config.email}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

registerTool(
  {
    name: "authenticate",
    description: "Add a new email account. For Gmail: opens a browser for OAuth. For IMAP/JMAP: stores encrypted credentials. Sensitive fields (username, password) can also be set via environment variables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        alias: { type: "string", description: "Short name for this account (e.g. 'personal', 'work')" },
        provider: { type: "string", enum: ["gmail", "imap", "jmap"], description: "Email provider type" },
        email: { type: "string", description: "Email address" },
        host: { type: "string", description: "IMAP server hostname (IMAP only)" },
        port: { type: "number", description: "IMAP server port (IMAP only, default 993)" },
        smtpHost: { type: "string", description: "SMTP server hostname (IMAP only)" },
        smtpPort: { type: "number", description: "SMTP server port (IMAP only, default 587)" },
        username: { type: "string", description: "IMAP/SMTP username (IMAP only)" },
        password: { type: "string", description: "IMAP/SMTP password or app password (IMAP only)" },
        passphrase: { type: "string", description: "Passphrase for encrypting credentials (IMAP/JMAP). Can also be set via MAILBOX_MCP_PASSPHRASE env var." },
        sessionUrl: { type: "string", description: "JMAP session URL override (JMAP only, auto-discovered from host by default)" },
      },
      required: ["alias", "provider", "email"],
    },
  },
  async (args, ctx) => {
    const alias = args.alias as string;
    const provider = args.provider as string;
    const email = args.email as string;

    if (provider === "gmail") {
      ctx.accountManager.addAccount(alias, { provider: "gmail", email });
      const { authenticateGmail } = await import("../auth/gmail-oauth.js");
      await authenticateGmail(ctx.accountManager.getConfigDir(), alias);
      return { content: [{ type: "text", text: `Gmail account "${alias}" (${email}) authenticated successfully.` }] };
    }

    if (provider === "imap") {
      const host = args.host as string;
      const port = (args.port as number) ?? 993;
      const smtpHost = args.smtpHost as string;
      const smtpPort = (args.smtpPort as number) ?? 587;
      const username = (args.username as string) || process.env.MAILBOX_MCP_IMAP_USERNAME;
      const password = (args.password as string) || process.env.MAILBOX_MCP_IMAP_PASSWORD;
      const passphrase = (args.passphrase as string) ?? process.env.MAILBOX_MCP_PASSPHRASE ?? "";

      if (!host || !smtpHost || !username || !password) {
        return { content: [{ type: "text", text: "IMAP accounts require: host, smtpHost, username, and password" }], isError: true };
      }

      if (!passphrase) {
        return { content: [{ type: "text", text: "IMAP accounts require a passphrase for credential encryption. Provide it as a parameter or set MAILBOX_MCP_PASSPHRASE." }], isError: true };
      }

      ctx.accountManager.addAccount(alias, { provider: "imap", email, host, port, smtpHost, smtpPort });
      const { encryptCredentials } = await import("../auth/imap-auth.js");
      encryptCredentials(ctx.accountManager.getConfigDir(), alias, { username, password }, passphrase);
      return { content: [{ type: "text", text: `IMAP account "${alias}" (${email}) configured. Credentials encrypted.` }] };
    }

    if (provider === "jmap") {
      const host = args.host as string;
      const username = (args.username as string) || process.env.MAILBOX_MCP_JMAP_USERNAME;
      const password = (args.password as string) || process.env.MAILBOX_MCP_JMAP_PASSWORD;
      const passphrase = (args.passphrase as string) ?? process.env.MAILBOX_MCP_PASSPHRASE ?? "";
      const sessionUrl = args.sessionUrl as string | undefined;

      if (!host || !username || !password) {
        return { content: [{ type: "text", text: "JMAP accounts require: host, username, and password" }], isError: true };
      }

      if (!passphrase) {
        return { content: [{ type: "text", text: "JMAP accounts require a passphrase for credential encryption. Provide it as a parameter or set MAILBOX_MCP_PASSPHRASE." }], isError: true };
      }

      // Validate sessionUrl early: must be HTTPS and not target private networks
      if (sessionUrl) {
        const { validateNoSSRF } = await import("../security/validation.js");
        try {
          const parsed = new URL(sessionUrl);
          if (parsed.protocol !== "https:") {
            return { content: [{ type: "text", text: "JMAP sessionUrl must use HTTPS." }], isError: true };
          }
          validateNoSSRF(sessionUrl);
        } catch (e: any) {
          return { content: [{ type: "text", text: `Invalid JMAP sessionUrl: ${e.message}` }], isError: true };
        }
      }

      const config: any = { provider: "jmap" as const, email, host };
      if (sessionUrl) config.sessionUrl = sessionUrl;
      ctx.accountManager.addAccount(alias, config);
      const { encryptJmapCredentials } = await import("../auth/jmap-auth.js");
      encryptJmapCredentials(ctx.accountManager.getConfigDir(), alias, { username, password }, passphrase);
      return { content: [{ type: "text", text: `JMAP account "${alias}" (${email}) configured. Credentials encrypted.` }] };
    }

    return { content: [{ type: "text", text: `Unknown provider: ${provider}` }], isError: true };
  }
);

registerTool(
  {
    name: "reauth",
    description: "Re-run OAuth for an existing Gmail account without removing it. Opens a browser for Google sign-in. Use when the refresh token expires (invalid_grant) or scopes change.",
    inputSchema: {
      type: "object" as const,
      properties: { alias: { type: "string", description: "Account alias to re-authenticate" } },
      required: ["alias"],
    },
  },
  async (args, ctx) => {
    const alias = args.alias as string;
    const account = ctx.accountManager.getAccount(alias);
    if (account.provider !== "gmail") {
      return {
        content: [{ type: "text", text: `reauth is Gmail-only. Account "${alias}" is ${account.provider}; re-run authenticate to rotate its credentials.` }],
        isError: true,
      };
    }
    const { authenticateGmail } = await import("../auth/gmail-oauth.js");
    await authenticateGmail(ctx.accountManager.getConfigDir(), alias);
    ctx.clearProviderCache?.(alias);
    return { content: [{ type: "text", text: `Gmail account "${alias}" (${account.email}) re-authenticated successfully.` }] };
  }
);

registerTool(
  {
    name: "remove_account",
    description: "Remove a configured email account and its stored credentials",
    inputSchema: {
      type: "object" as const,
      properties: { alias: { type: "string", description: "Account alias to remove" } },
      required: ["alias"],
    },
  },
  async (args, ctx) => {
    const alias = args.alias as string;
    ctx.accountManager.removeAccount(alias);
    ctx.clearProviderCache?.(alias);
    clearSendLimit(alias);
    return { content: [{ type: "text", text: `Account "${alias}" removed.` }] };
  }
);
