import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secureWriteFile, ensureDir } from "../security/permissions.js";

export interface JmapCredentials {
  username: string;
  password: string;
}

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

export function encryptJmapCredentials(
  configDir: string,
  alias: string,
  creds: JmapCredentials,
  passphrase: string
): void {
  if (!passphrase) {
    throw new Error("A passphrase is required to encrypt JMAP credentials");
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(creds);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const stored = {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    data: encrypted.toString("base64"),
  };

  const accountDir = join(configDir, "accounts", alias);
  ensureDir(accountDir);
  secureWriteFile(join(accountDir, "credentials.json"), JSON.stringify(stored, null, 2));
}

export function decryptJmapCredentials(
  configDir: string,
  alias: string,
  passphrase: string
): JmapCredentials {
  if (!passphrase) {
    throw new Error("A passphrase is required to decrypt JMAP credentials. Set MAILBOX_MCP_PASSPHRASE or pass it directly.");
  }

  const credPath = join(configDir, "accounts", alias, "credentials.json");
  if (!existsSync(credPath)) {
    throw new Error(`No credentials found for account "${alias}"`);
  }

  const stored = JSON.parse(readFileSync(credPath, "utf-8"));
  const salt = Buffer.from(stored.salt, "base64");
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(stored.iv, "base64");
  const authTag = Buffer.from(stored.authTag, "base64");
  const data = Buffer.from(stored.data, "base64");

  // AES-GCM auth tag verification is constant-time in Node.js crypto,
  // so wrong-passphrase errors don't leak timing information.
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return JSON.parse(decrypted.toString("utf-8")) as JmapCredentials;
}
