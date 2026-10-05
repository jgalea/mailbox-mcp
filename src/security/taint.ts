import type { AccountConfig } from "../accounts.js";
import type { SenderAuth } from "../providers/interface.js";
import { strictAddress } from "../providers/headers.js";
import { isAllowedRecipient } from "./send-guard.js";
import { stripInvisibleChars } from "./sanitize.js";

// Per-process record of which accounts have shown the model mail it cannot
// vouch for. Once that has happened the session may be carrying injected
// instructions, so untrustedReadLock routes or refuses sends for the rest of
// the process. Deliberately in memory only: a restart is the reset, and
// nothing the model can call clears it.
export interface TaintInfo {
  sender: string;
  tool: string;
  at: string;
}

/** What a tool knows about one rendered message: its From header and the receiving server's authentication evidence, if any. */
export interface SenderEvidence {
  from: string;
  auth?: SenderAuth;
}

const tainted = new Map<string, TaintInfo>();

export const senderAddress = strictAddress;

export function isTainted(account: string): TaintInfo | undefined {
  return tainted.get(account);
}

export function clearTaint(account?: string): void {
  if (account === undefined) tainted.clear();
  else tainted.delete(account);
}

export function markTainted(account: string, config: AccountConfig | undefined, tool: string, sender: string): void {
  if (!config?.untrustedReadLock || tainted.has(account)) return;
  tainted.set(account, { sender, tool, at: new Date().toISOString() });
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

// The only two inputs to this decision are things neither a sender nor the
// model can steer: the trustedSenders list in accounts.json, and the
// receiving server's own DMARC verdict. Being in Sent, the local send log and
// provider searches used to count too, and every one of them can be moved by
// labelling or filing a message, so none of them does any more.
export function isTrustedSender(config: AccountConfig | undefined, evidence: SenderEvidence): boolean {
  const address = strictAddress(evidence.from);
  if (!address || !config) return false;
  const trusted = config.trustedSenders ?? [];
  if (trusted.length === 0 || !isAllowedRecipient(address, trusted)) return false;
  return dmarcPasses(evidence.auth?.authenticationResults, address, authservIdFor(config));
}

// Called after a tool has rendered messages for an account. Stops at the
// first untrusted sender; an account already tainted is not re-checked. Any
// failure while deciding counts as untrusted.
export function noteSenders(account: string, config: AccountConfig | undefined, tool: string, evidence: SenderEvidence[]): void {
  if (!config?.untrustedReadLock || tainted.has(account)) return;
  if (evidence.length === 0) return;
  try {
    for (const item of evidence) {
      if (!isTrustedSender(config, item)) {
        markTainted(account, config, tool, strictAddress(item.from) ?? describe(item.from));
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
