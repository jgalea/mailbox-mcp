import { randomBytes } from "node:crypto";
import { htmlToVisibleText } from "./html-text.js";

// Zero-width and bidirectional control characters. Invisible in a mail client,
// but they split or reorder words for the model and are a common way to hide
// instructions in plain sight.
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function stripInvisibleChars(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = text.replace(INVISIBLE_CHARS, () => { removed++; return ""; });
  return { text: cleaned, removed };
}

// Characters that read as the letters of UNTRUSTED, an opening bracket or a
// slash but have different code points. NFKC covers the fullwidth and
// mathematical forms; the Cyrillic and Greek homoglyphs need a map.
const CONFUSABLES: Record<string, string> = {
  "Т": "T", "Τ": "T", "Ѕ": "S", "ѕ": "S", "Е": "E", "е": "E", "Ε": "E",
  "Ν": "N", "Ԁ": "D", "ԁ": "D", "Α": "A", "А": "A", "а": "A",
  "【": "[", "❲": "[", "⁅": "[", "∕": "/", "⁄": "/", "⧸": "/",
};

function canonicalChar(ch: string): string {
  if (CONFUSABLES[ch]) return CONFUSABLES[ch];
  const folded = ch.normalize("NFKC");
  const upper = (folded.length === 1 ? folded : ch).toUpperCase();
  return upper.length === 1 ? upper : "�";
}

const FENCE_LIKE = /\[\s*\/?\s*UNTRUSTED/g;

// Replace the opening bracket of anything that looks like a fence marker with
// U+27E6, so content can never open or close a fence. Matching runs on a
// per-code-point canonical copy of the text (same length as the input), which
// catches case variants and Unicode lookalikes while leaving the original text
// otherwise untouched.
export function escapeFenceTags(content: string): string {
  const chars = Array.from(content);
  const canonical = chars.map(canonicalChar).join("");
  let changed = false;
  let m: RegExpExecArray | null;
  FENCE_LIKE.lastIndex = 0;
  while ((m = FENCE_LIKE.exec(canonical))) {
    chars[m.index] = "⟦";
    changed = true;
  }
  return changed ? chars.join("") : content;
}

export function newFenceNonce(): string {
  return randomBytes(4).toString("hex");
}

export type FenceKind = "body" | "subject";

// One per tool response: the same nonce on every marker in the response, plus a
// running count of what was removed so the registry can append a warning.
export class ResponseFence {
  readonly nonce: string;
  hiddenTextChars = 0;
  invisibleChars = 0;

  constructor(nonce: string = newFenceNonce()) {
    this.nonce = nonce;
  }

  private wrap(tag: string, content: string): string {
    const stripped = stripInvisibleChars(content);
    this.invisibleChars += stripped.removed;
    const full = `${tag}_${this.nonce}`;
    return `[${full}]\n${escapeFenceTags(stripped.text)}\n[/${full}]`;
  }

  content(text: string, kind: FenceKind = "body"): string {
    return this.wrap(kind === "subject" ? "UNTRUSTED_SUBJECT" : "UNTRUSTED_EMAIL_CONTENT", text);
  }

  body(text: string, isHtml?: boolean): string {
    if (!isHtml) return this.content(text);
    const visible = htmlToVisibleText(text);
    this.hiddenTextChars += visible.hiddenChars;
    return this.content(visible.text);
  }

  header(value: string, field: string): string {
    return this.wrap(`UNTRUSTED_${field.toUpperCase()}`, value);
  }

  warnings(): string[] {
    const out: string[] = [];
    if (this.hiddenTextChars > 0) {
      out.push(`Warning: this email contained ${this.hiddenTextChars} characters of hidden text (not visible in a mail client), which were removed. Hidden text is a common prompt-injection technique.`);
    }
    if (this.invisibleChars > 0) {
      out.push(`Warning: ${this.invisibleChars} invisible characters (zero-width or bidirectional controls) were removed from this email. Invisible characters are a common prompt-injection technique.`);
    }
    return out;
  }
}

const FENCE_MARKER = /(?:\[UNTRUSTED_[A-Z_]+?(?:_[0-9a-f]{6,})?\]\n?|\n?\[\/UNTRUSTED_[A-Z_]+?(?:_[0-9a-f]{6,})?\])/g;

// Remove fence markers (the nonce format and the pre-0.11 fixed format) and
// undo the bracket escaping, so nothing fence-related reaches a real
// recipient. Applied to every outgoing subject and body.
export function stripFencing(text: string): string {
  return text
    .replace(FENCE_MARKER, "")
    .replace(/⟦(\s*\/?\s*UNTRUSTED)/gi, "[$1");
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
