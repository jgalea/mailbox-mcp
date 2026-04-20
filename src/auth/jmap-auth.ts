import {
  encryptCredentialsFile,
  decryptCredentialsFile,
  type StoredCredentials,
} from "./credentials.js";

export type JmapCredentials = StoredCredentials;

export function encryptJmapCredentials(
  configDir: string,
  alias: string,
  creds: JmapCredentials,
  passphrase: string,
): void {
  encryptCredentialsFile(configDir, alias, creds, passphrase, "JMAP");
}

export function decryptJmapCredentials(
  configDir: string,
  alias: string,
  passphrase: string,
): JmapCredentials {
  return decryptCredentialsFile(configDir, alias, passphrase, "JMAP");
}
