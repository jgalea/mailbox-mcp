/**
 * Return `subject` with an `Re: ` prefix added unless one already exists.
 * Matches `Re:`, `RE:`, `re:`, `Re :` etc. — but not non-reply strings like
 * "Are: the books ready" where `includes("Re:")` would give a false positive.
 */
export function ensureReplyPrefix(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * Return `subject` with a `Fwd: ` prefix added unless one already exists.
 * Accepts the common variants `Fwd:`, `Fw:`, `FWD:`, case-insensitive.
 */
export function ensureForwardPrefix(subject: string): string {
  return /^\s*fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/**
 * Split a header value like `"Smith, John" <j@x>, Other <o@y>` into the
 * individual address strings. Commas inside double-quoted display names or
 * inside angle brackets are preserved.
 */
export function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && inQuotes && i + 1 < raw.length) {
      buf += ch + raw[i + 1];
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = !inQuotes; buf += ch; continue; }
    if (!inQuotes) {
      if (ch === "<") depth++;
      else if (ch === ">") depth = Math.max(0, depth - 1);
    }
    if (!inQuotes && depth === 0 && ch === ",") {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const trimmed = buf.trim();
  if (trimmed) out.push(trimmed);
  return out;
}
