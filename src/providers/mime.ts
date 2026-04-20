import { randomBytes } from "node:crypto";
import type { Attachment } from "./interface.js";
import { stripCRLF } from "../security/validation.js";

export interface BuildMimeOptions {
  from?: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  html?: boolean;
  attachments?: Attachment[];
}

/**
 * Base64-encode a buffer and wrap to 76-char lines as required by RFC 2045.
 * Node's Buffer.toString("base64") emits a single unbroken line which many
 * SMTP relays will happily truncate above ~990 chars.
 */
function base64Wrap(data: Buffer): string {
  const b64 = data.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/**
 * Encode a header parameter value using RFC 2047 (Q-encoding) when it
 * contains non-ASCII characters — needed so international filenames
 * survive through to the recipient.
 */
function encodeHeaderParameter(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value) && !/[=?"]/.test(value)) {
    return `"${value}"`;
  }
  const encoded = Buffer.from(value, "utf-8")
    .toString("base64");
  return `=?utf-8?B?${encoded}?=`;
}

/**
 * Encode an unstructured header value (like Subject) as an RFC 2047
 * encoded-word when it contains non-ASCII. Headers must be 7-bit clean;
 * sending raw UTF-8 gets mangled by relays that treat bytes as Latin-1
 * and re-encode.
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value;
  }
  const encoded = Buffer.from(value, "utf-8").toString("base64");
  return `=?utf-8?B?${encoded}?=`;
}

/** Build a raw RFC 2822 message as a Buffer, with optional multipart/mixed attachments. */
export function buildRawMimeMessage(opts: BuildMimeOptions): Buffer {
  const hasAttachments = !!opts.attachments && opts.attachments.length > 0;
  const bodyContentType = opts.html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";

  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${stripCRLF(opts.from)}`);
  headers.push(`To: ${stripCRLF(opts.to.join(", "))}`);
  if (opts.cc?.length) headers.push(`Cc: ${stripCRLF(opts.cc.join(", "))}`);
  if (opts.bcc?.length) headers.push(`Bcc: ${stripCRLF(opts.bcc.join(", "))}`);
  if (opts.replyTo) headers.push(`Reply-To: ${stripCRLF(opts.replyTo)}`);
  headers.push(`Subject: ${encodeHeaderValue(stripCRLF(opts.subject))}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${stripCRLF(opts.inReplyTo)}`);
  if (opts.references) headers.push(`References: ${stripCRLF(opts.references)}`);
  headers.push("MIME-Version: 1.0");

  if (!hasAttachments) {
    headers.push(`Content-Type: ${bodyContentType}`);
    headers.push("Content-Transfer-Encoding: 8bit");
    const raw = `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
    return Buffer.from(raw, "utf-8");
  }

  const boundary = `----=_Part_${randomBytes(12).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push(`Content-Type: ${bodyContentType}`);
  parts.push("Content-Transfer-Encoding: 8bit");
  parts.push("");
  parts.push(opts.body);

  for (const att of opts.attachments!) {
    const safeName = stripCRLF(att.filename);
    const nameParam = encodeHeaderParameter(safeName);
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name=${nameParam}`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename=${nameParam}`);
    parts.push("");
    parts.push(base64Wrap(att.data));
  }
  parts.push(`--${boundary}--`);
  parts.push("");

  const raw = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  return Buffer.from(raw, "utf-8");
}
