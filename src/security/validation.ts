import { URL } from "node:url";

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^0:0:0:0:0:0:0:1$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
];

/** Blocked hostnames that resolve to localhost or cloud metadata endpoints. */
const BLOCKED_HOSTNAMES = [
  "localhost",
  "metadata.google.internal",
  "169.254.169.254", // AWS/GCP metadata
];

export function isPrivateIP(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

/**
 * Normalise an IP string to catch common SSRF evasion techniques:
 * hex (0x7f000001), octal (0177.0.0.1), decimal (2130706433),
 * IPv4-mapped IPv6 (::ffff:127.0.0.1), and bracket notation.
 */
function normalizeIP(hostname: string): string | null {
  // Strip IPv6 brackets
  let h = hostname.replace(/^\[|\]$/g, "");

  // IPv4-mapped IPv6: ::ffff:127.0.0.1
  const v4mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) return v4mapped[1];

  // Decimal integer form: e.g. 2130706433 = 127.0.0.1
  if (/^\d{1,10}$/.test(h)) {
    const num = parseInt(h, 10);
    if (num >= 0 && num <= 0xFFFFFFFF) {
      return `${(num >>> 24) & 0xFF}.${(num >>> 16) & 0xFF}.${(num >>> 8) & 0xFF}.${num & 0xFF}`;
    }
  }

  // Hex form: 0x7f000001
  if (/^0x[0-9a-fA-F]{1,8}$/.test(h)) {
    const num = parseInt(h, 16);
    return `${(num >>> 24) & 0xFF}.${(num >>> 16) & 0xFF}.${(num >>> 8) & 0xFF}.${num & 0xFF}`;
  }

  // Octal octets: 0177.0.0.01
  if (/^0\d+(\.\d+){0,3}$/.test(h)) {
    const parts = h.split(".").map(p => parseInt(p, 8));
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
      return parts.join(".");
    }
  }

  return null;
}

export function validateNoSSRF(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: blocked`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    throw new Error(`URL targets a private/reserved address: blocked`);
  }

  // Check hostname as-is
  if (isPrivateIP(hostname)) {
    throw new Error(`URL targets a private/reserved address: blocked`);
  }

  // Check normalised form to catch hex/octal/decimal/IPv4-mapped evasion
  const normalized = normalizeIP(hostname);
  if (normalized && isPrivateIP(normalized)) {
    throw new Error(`URL targets a private/reserved address: blocked`);
  }
}

export function stripCRLF(value: string): string {
  return value.split("\r").join("").split("\n").join("");
}

export function validateAttachmentPath(filename: string): void {
  if (filename.includes("..") || filename.startsWith("/") || filename.startsWith("\\")) {
    throw new Error(`Invalid attachment filename: path traversal blocked`);
  }
}
