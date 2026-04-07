/** Escape fence-like patterns in untrusted content to prevent tag injection. */
function escapeFenceTags(content: string): string {
  return content
    .replace(/\[UNTRUSTED_/g, "\u27E6UNTRUSTED_")
    .replace(/\[\/UNTRUSTED_/g, "\u27E6/UNTRUSTED_");
}

export function fenceEmailContent(
  content: string,
  type: "body" | "subject" = "body"
): string {
  const tag = type === "subject" ? "UNTRUSTED_SUBJECT" : "UNTRUSTED_EMAIL_CONTENT";
  const escaped = escapeFenceTags(content);
  return `[${tag}]\n${escaped}\n[/${tag}]`;
}

export function fenceEmailHeader(value: string, field: string): string {
  const escaped = escapeFenceTags(value);
  return `[UNTRUSTED_${field.toUpperCase()}]\n${escaped}\n[/UNTRUSTED_${field.toUpperCase()}]`;
}

/** Strip prompt-injection fencing tags, keeping inner content. Used before sending email to real recipients. */
export function stripFencing(text: string): string {
  return text
    .replace(/\[UNTRUSTED_[A-Z_]+\]\n?/g, "")
    .replace(/\[\/UNTRUSTED_[A-Z_]+\]\n?/g, "")
    .replace(/\u27E6(UNTRUSTED_)/g, "[$1")
    .replace(/\u27E6(\/?UNTRUSTED_)/g, "[$1");
}

export function redactTokens(message: string): string {
  return message
    .split(/ya29\.[^\s"']+/)
    .join("[REDACTED]")
    .split(/eyJ[A-Za-z0-9_-]+\./)
    .join("[REDACTED]")
    .split(/Bearer\s+[^\s"']+/)
    .join("Bearer [REDACTED]")
    .split(/Basic\s+[A-Za-z0-9+/=]+/)
    .join("Basic [REDACTED]");
}
