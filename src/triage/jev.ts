import type { EmailSummary } from "../providers/interface.js";
import { stripInvisibleChars } from "../security/sanitize.js";

// Optional inbox triage through TypeSafe's Jev, a decision model that can only
// pick from the options below. Email text can't steer it into anything else,
// which is why it's safe to run over untrusted mail. Off unless a key is set.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_MESSAGES = 25;
const CONCURRENCY = 5;
const TIMEOUT_MS = 10_000;
const MAX_STATE_CHARS = 2_000;

export const CATEGORIES = {
  needs_reply: "A real person is writing to the recipient and expects an answer or a decision",
  fyi: "Personal or work information for the recipient that needs no reply",
  newsletter: "A newsletter, digest, blog update or marketing email",
  receipt: "A receipt, invoice, order confirmation, payment or shipping notice",
  notification: "An automated notification from an app or service, such as an alert, comment, sign-in or report",
  suspicious: "Phishing, a scam, or an unexpected request for money, credentials or personal data",
} as const;

export type Category = keyof typeof CATEGORIES;

export const CATEGORY_LABELS: Record<Category, string> = {
  needs_reply: "needs reply",
  fyi: "FYI",
  newsletter: "newsletter",
  receipt: "receipt",
  notification: "notification",
  suspicious: "suspicious",
};

export interface Triage {
  category: Category;
  confidence: number;
  urgent: boolean;
}

export function jevApiKey(): string | undefined {
  return process.env.MAILBOX_MCP_TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY || undefined;
}

function stateFor(m: EmailSummary): string {
  const text = `From: ${m.from}\nSubject: ${m.subject}\n\n${m.snippet}`;
  return stripInvisibleChars(text).text.slice(0, MAX_STATE_CHARS);
}

const QUESTIONS = {
  category: {
    type: "choice",
    instructions: "Which kind of email is this, from the recipient's point of view?",
    criteria: CATEGORIES,
  },
  urgent: {
    type: "noul",
    instructions: "Does the sender need something from the recipient within about a day?",
  },
};

async function triageOne(m: EmailSummary, key: string, fetchImpl: typeof fetch): Promise<Triage | null> {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: stateFor(m), model: "jev-latest", questions: QUESTIONS }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    answers?: { category?: { choice?: unknown; confidence?: unknown }; urgent?: { noul?: unknown } };
  };
  const choice = data.answers?.category?.choice;
  if (typeof choice !== "string" || !Object.hasOwn(CATEGORIES, choice)) return null;
  const confidence = Number(data.answers?.category?.confidence);
  const urgent = Number(data.answers?.urgent?.noul);
  return {
    category: choice as Category,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    urgent: Number.isFinite(urgent) && urgent >= 0.5,
  };
}

export async function triageMessages(
  messages: EmailSummary[],
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ results: Map<string, Triage>; failed: number }> {
  const batch = messages.slice(0, MAX_MESSAGES);
  const results = new Map<string, Triage>();
  let failed = 0;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(slice.map((m) => triageOne(m, key, fetchImpl)));
    settled.forEach((s, j) => {
      if (s.status === "fulfilled" && s.value) results.set(slice[j].id, s.value);
      else failed++;
    });
  }
  return { results, failed };
}

export function formatTriage(t: Triage): string {
  return `[${CATEGORY_LABELS[t.category]}${t.urgent ? ", urgent" : ""}, ${Math.round(t.confidence * 100)}%]`;
}
