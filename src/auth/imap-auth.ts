import {
  encryptCredentialsFile,
  decryptCredentialsFile,
  type StoredCredentials,
} from "./credentials.js";

export type ImapCredentials = StoredCredentials;

export function encryptCredentials(
  configDir: string,
  alias: string,
  creds: ImapCredentials,
  passphrase: string,
): void {
  encryptCredentialsFile(configDir, alias, creds, passphrase, "IMAP");
}

export function decryptCredentials(
  configDir: string,
  alias: string,
  passphrase: string,
): ImapCredentials {
  return decryptCredentialsFile(configDir, alias, passphrase, "IMAP");
}
