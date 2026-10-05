import type { AccountConfig } from "../accounts.js";
import type { MailProvider } from "../providers/interface.js";
import { extractAddress, splitAddressList } from "../providers/headers.js";
import { stripInvisibleChars } from "./sanitize.js";
import { hasSentTo } from "../sendlog.js";

// Per-process record of which accounts have shown the model mail from a
// sender the account never wrote to. Once that has happened the session may
// be carrying injected instructions, so untrustedReadLock routes or refuses
// sends for the rest of the process. Deliberately in memory only: a restart
// is the reset, and nothing the model can call clears it.
export interface TaintInfo {
  sender: string;
  tool: string;
  at: string;
}

const tainted = new Map<string, TaintInfo>();
const providerSentTo = new Map<string, boolean>();

const ADDR_SPEC = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:.]+$/;

export function isTainted(account: string): TaintInfo | undefined {
  return tainted.get(account);
}

export function clearTaint(account?: string): void {
  if (account === undefined) {
    tainted.clear();
    providerSentTo.clear();
  } else {
    tainted.delete(account);
  }
}

export function markTainted(account: string, config: AccountConfig | undefined, tool: string, sender: string): void {
  if (!config?.untrustedReadLock || tainted.has(account)) return;
  tainted.set(account, { sender, tool, at: new Date().toISOString() });
}

// Reduces a From header to one bare address, or to null when a parser could
// read it two ways: several addresses, a display name carrying its own angle
// brackets or @, invisible or control characters, or no usable address at
// all. Null is never trusted, so every ambiguity lands on the safe side.
export function senderAddress(raw: string): string | null {
  const { text, removed } = stripInvisibleChars(raw);
  if (removed > 0 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const parts = splitAddressList(text);
  if (parts.length !== 1) return null;
  const part = parts[0];
  const angled = [...part.matchAll(/<([^<>]*)>/g)];
  if (angled.length > 1) return null;
  let address = part.trim();
  if (angled.length === 1) {
    const match = angled[0];
    address = match[1].trim();
    const display = part.slice(0, match.index) + part.slice(match.index! + match[0].length);
    if (/[<>@]/.test(display)) return null;
  }
  if (!ADDR_SPEC.test(address)) return null;
  return address.toLowerCase();
}

// A sender is trusted only if it is the account itself or an address the
// account has written to: per the local send log, or per the provider's Sent
// folder when it can check. Having received mail from someone proves nothing,
// since received mail is how injection arrives. A failed lookup counts as
// untrusted and is not cached, so a transient error does not stick.
export async function isTrustedSender(account: string, config: AccountConfig | undefined, provider: MailProvider, raw: string): Promise<boolean> {
  const address = senderAddress(raw);
  if (!address) return false;
  if (config && extractAddress(config.email) === address) return true;
  if (hasSentTo(account, address)) return true;
  if (!provider.hasSentTo) return false;
  const key = `${account}\n${address}`;
  const cached = providerSentTo.get(key);
  if (cached !== undefined) return cached;
  try {
    const result = await provider.hasSentTo(address);
    providerSentTo.set(key, result);
    return result;
  } catch {
    return false;
  }
}

// Called after a tool has rendered sender addresses for an account. Stops at
// the first untrusted one; an account already tainted is not re-checked. Any
// failure while deciding counts as untrusted.
export async function noteSenders(
  account: string,
  config: AccountConfig | undefined,
  getProvider: () => MailProvider | Promise<MailProvider>,
  tool: string,
  senders: string[],
): Promise<void> {
  if (!config?.untrustedReadLock || tainted.has(account)) return;
  const unique = [...new Set(senders)];
  if (unique.length === 0) return;
  try {
    const provider = await getProvider();
    for (const sender of unique) {
      if (!(await isTrustedSender(account, config, provider, sender))) {
        markTainted(account, config, tool, senderAddress(sender) ?? describe(sender));
        return;
      }
    }
  } catch {
    markTainted(account, config, tool, describe(unique[0]));
  }
}

function describe(raw: string): string {
  const shown = stripInvisibleChars(raw).text.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 80);
  return shown ? `an unparsable sender (${shown})` : "a message with no sender";
}
