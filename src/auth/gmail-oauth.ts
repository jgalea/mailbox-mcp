import { createServer } from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { secureWriteFile, ensureDir } from "../security/permissions.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",      // Read, send, trash, labels, filters
  "https://www.googleapis.com/auth/gmail.compose",      // Create drafts, send messages
  "https://www.googleapis.com/auth/gmail.settings.basic", // Signatures, vacation, send-as, filters
  "https://www.googleapis.com/auth/contacts.readonly",  // Contact search (search_contacts tool)
];

const REDIRECT_PORT = 4895;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

interface OAuthKeys {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

function loadOAuthKeys(configDir: string): { clientId: string; clientSecret: string } {
  const keysPath = join(configDir, "oauth-keys.json");
  if (!existsSync(keysPath)) {
    throw new Error(
      `OAuth keys not found at ${keysPath}. Download from Google Cloud Console and save there.`
    );
  }
  const keys: OAuthKeys = JSON.parse(readFileSync(keysPath, "utf-8"));
  const creds = keys.installed ?? keys.web;
  if (!creds) {
    throw new Error("Invalid oauth-keys.json: expected 'installed' or 'web' credentials");
  }
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

export async function authenticateGmail(
  configDir: string,
  alias: string
): Promise<void> {
  const { clientId, clientSecret } = loadOAuthKeys(configDir);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const state = randomBytes(32).toString("hex");

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
  });

  const securityHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  };

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        res.writeHead(403, securityHeaders);
        res.end("<h1>Authentication failed</h1><p>State mismatch — possible CSRF attack. You can close this tab.</p>");
        server.close();
        reject(new Error("OAuth state mismatch: possible CSRF attack"));
        return;
      }

      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, securityHeaders);
        res.end("<h1>Authentication failed</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!authCode) {
        res.writeHead(400, securityHeaders);
        res.end("<h1>Missing authorization code</h1>");
        server.close();
        reject(new Error("No authorization code received"));
        return;
      }

      res.writeHead(200, securityHeaders);
      res.end("<h1>Authentication successful</h1><p>You can close this tab.</p>");
      server.close();
      resolve(authCode);
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.error(`\nOpen this URL to authenticate:\n\n${authUrl}\n`);
    });

    server.on("error", reject);
  });

  const { tokens } = await oauth2Client.getToken(code);

  const accountDir = join(configDir, "accounts", alias);
  ensureDir(accountDir);
  secureWriteFile(join(accountDir, "token.json"), JSON.stringify(tokens, null, 2));
}

export function getGmailClient(configDir: string, alias: string) {
  const { clientId, clientSecret } = loadOAuthKeys(configDir);
  const tokenPath = join(configDir, "accounts", alias, "token.json");

  if (!existsSync(tokenPath)) {
    throw new Error(`No OAuth token for account "${alias}". Run authenticate first.`);
  }

  const tokens = JSON.parse(readFileSync(tokenPath, "utf-8"));
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials(tokens);

  oauth2Client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    secureWriteFile(tokenPath, JSON.stringify(merged, null, 2));
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}
