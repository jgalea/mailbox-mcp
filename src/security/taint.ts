import type { AccountConfig } from "../accounts.js";
import type { MailProvider, SenderAuth } from "../providers/interface.js";
import { splitAddressList } from "../providers/headers.js";
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

/** What a tool knows about one rendered message: its From header and the provider's authentication evidence, if any. */
export interface SenderEvidence {
  from: string;
  auth?: SenderAuth;
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

// The authserv-id the account's own provider writes into the topmost
// Authentication-Results header. Gmail's is fixed; IMAP and JMAP servers vary,
// so there it must be configured, and until it is no received mail can be
// authenticated, which means every third-party sender taints.
export function authservIdFor(config: AccountConfig): string | undefined {
  return config.authservId ?? (config.provider === "gmail" ? "mx.google.com" : undefined);
}

// A From header is attacker-controlled, so it only counts once the receiving
// server has vouched for it: the topmost Authentication-Results header must
// come from the account's own provider, carry exactly one dmarc result that
// is "pass", and name the From domain as header.from. Anything missing or
// ambiguous is not authenticated.
export function dmarcPasses(results: string[] | undefined, address: string, authservId: string | undefined): boolean {
  if (!results || results.length === 0 || !authservId) return false;
  const segments = results[0].split(";").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  if (segments[0].split(/\s+/)[0].toLowerCase() !== authservId.toLowerCase()) return false;
  const dmarc = segments.filter((s) => /^dmarc=/i.test(s));
  if (dmarc.length !== 1 || !/^dmarc=pass(\s|$|\()/i.test(dmarc[0])) return false;
  const headerFrom = /\bheader\.from=([^\s;()]+)/i.exec(dmarc[0]);
  if (!headerFrom) return false;
  return headerFrom[1].toLowerCase() === address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

// A sender is trusted only when the account wrote the message itself (it sits
// in Sent), or when the message is authenticated by the provider's DMARC
// check AND the account has written to that address before, per the local
// send log or an exact match in the provider's Sent folder. Having received
// mail from someone proves nothing, and neither does a From header on its
// own, since forging one costs nothing. A failed lookup counts as untrusted
// and is not cached, so a transient error does not stick.
export async function isTrustedSender(account: string, config: AccountConfig | undefined, provider: MailProvider, evidence: SenderEvidence): Promise<boolean> {
  const address = senderAddress(evidence.from);
  if (!address || !config) return false;
  if (evidence.auth?.sent === true) return true;
  if (!dmarcPasses(evidence.auth?.authenticationResults, address, authservIdFor(config))) return false;
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

// Called after a tool has rendered messages for an account. Stops at the
// first untrusted sender; an account already tainted is not re-checked. Any
// failure while deciding counts as untrusted.
export async function noteSenders(
  account: string,
  config: AccountConfig | undefined,
  getProvider: () => MailProvider | Promise<MailProvider>,
  tool: string,
  evidence: SenderEvidence[],
): Promise<void> {
  if (!config?.untrustedReadLock || tainted.has(account)) return;
  if (evidence.length === 0) return;
  try {
    const provider = await getProvider();
    for (const item of evidence) {
      if (!(await isTrustedSender(account, config, provider, item))) {
        markTainted(account, config, tool, senderAddress(item.from) ?? describe(item.from));
        return;
      }
    }
  } catch {
    markTainted(account, config, tool, describe(evidence[0].from));
  }
}

function describe(raw: string): string {
  const shown = stripInvisibleChars(raw).text.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 80);
  return shown ? `an unparsable sender (${shown})` : "a message with no sender";
}
