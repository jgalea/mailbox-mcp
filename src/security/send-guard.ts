import type { AccountConfig } from "../accounts.js";
import type { MailProvider } from "../providers/interface.js";
import { extractAddress, strictAddress } from "../providers/headers.js";
import { hasSentTo, sendsInLastDay } from "../sendlog.js";

export const DEFAULT_DAILY_SEND_LIMIT = 100;

export interface OutgoingCheck {
  account: string;
  config: AccountConfig | undefined;
  provider: MailProvider;
  /** Every address the message will go to (To, Cc, Bcc), as given by the caller. */
  recipients: string[];
  /** Addresses that came from a message the account already received (reply targets). They skip the new-recipient check. */
  knownRecipients?: string[];
  confirmNewRecipient?: boolean;
  isForward?: boolean;
  confirmExternalForward?: boolean;
  /** Draft creation: allowlist applies, confirmations and the daily cap do not. */
  draftOnly?: boolean;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

export function isAllowedRecipient(address: string, allowlist: string[]): boolean {
  const bare = extractAddress(address);
  const domain = domainOf(bare);
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.startsWith("@") ? domain === e.slice(1) : bare === e;
  });
}

async function isKnownRecipient(check: OutgoingCheck, address: string): Promise<boolean> {
  const bare = extractAddress(address);
  if (!bare) return false;
  if (check.config && extractAddress(check.config.email) === bare) return true;
  if (hasSentTo(check.account, bare)) return true;
  if (check.provider.hasCorrespondedWith) {
    try {
      return await check.provider.hasCorrespondedWith(bare);
    } catch {
      return false;
    }
  }
  return false;
}

// Returns null when the send may proceed, otherwise the error text to hand
// back to the model. Every outgoing path (send, reply, forward, send_draft,
// send_template, create_draft) runs through here.
export async function checkOutgoing(check: OutgoingCheck): Promise<string | null> {
  const recipients = check.recipients.map((r) => r.trim()).filter(Boolean);
  // A value like "boss@example.com, leak@attacker.example" or two angle
  // groups would be checked as its first address and delivered to both, so
  // every recipient has to be one plain address before anything else runs.
  const malformed = recipients.filter((r) => strictAddress(r) === null);
  if (malformed.length > 0) {
    return `Refused: each recipient must be a single plain address (user@example.com or Name <user@example.com>, one per entry). Not accepted: ${malformed.join(" | ")}.`;
  }
  const allowlist = check.config?.allowedRecipients;
  if (allowlist && allowlist.length > 0) {
    const blocked = recipients.filter((r) => !isAllowedRecipient(r, allowlist));
    if (blocked.length > 0) {
      return `Refused: account "${check.account}" may only send to its configured allowlist (${allowlist.join(", ")}). Not allowed: ${blocked.map(extractAddress).join(", ")}. The allowlist is set in accounts.json and cannot be changed from here.`;
    }
  }

  if (check.draftOnly) return null;

  const problems: string[] = [];

  if (check.isForward && !check.confirmExternalForward && check.config?.email) {
    const ownDomain = domainOf(extractAddress(check.config.email));
    const external = recipients.map(extractAddress).filter((r) => domainOf(r) !== ownDomain);
    if (external.length > 0) {
      problems.push(`Forwarding to a domain other than the account's own (${ownDomain}) sends mail content outside the account: ${external.join(", ")}. If the user explicitly asked for this, call again with confirm_external_forward: true.`);
    }
  }

  if (!check.confirmNewRecipient) {
    const known = new Set((check.knownRecipients ?? []).map(extractAddress));
    const fresh: string[] = [];
    for (const r of recipients) {
      const bare = extractAddress(r);
      if (known.has(bare)) continue;
      if (!(await isKnownRecipient(check, bare))) fresh.push(bare);
    }
    if (fresh.length > 0) {
      problems.push(`This account has never sent to or received from: ${fresh.join(", ")}. Sending to a new address is how a prompt-injected session leaks mail, so it needs the user's explicit go-ahead. If the user asked for exactly these recipients, call again with confirm_new_recipient: true.`);
    }
  }

  if (problems.length > 0) return `Refused: ${problems.join(" Also: ")}`;

  const limit = check.config?.dailySendLimit ?? DEFAULT_DAILY_SEND_LIMIT;
  const sent = sendsInLastDay(check.account);
  if (sent >= limit) {
    return `Daily send limit reached: ${sent} messages sent from "${check.account}" in the last 24 hours (limit ${limit}, configurable per account via dailySendLimit in accounts.json).`;
  }
  return null;
}
