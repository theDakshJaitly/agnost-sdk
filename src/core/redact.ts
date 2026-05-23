import type { ReadableSpanLike, ReadableSpanEvent } from "./schema.js";

// Content-safety hook. Two concerns, deliberately separate:
//
//   1. `captureContent` (boolean) — gates whether prompt/response content
//      attributes are exported at all. When false, content is *stripped*
//      from the span before export (not replaced with a placeholder).
//      Default is false at the public API surface; the privacy story is
//      opt-in.
//
//   2. `redact` (Redactor) — a pluggable function applied to content that
//      *is* being captured. The default redactor below catches structured
//      PII shapes only (emails, phone-like, common API-key prefixes). It
//      is NOT a full PII-redaction solution; production deployments are
//      expected to supply their own. The point is the hook at the right
//      seam — span-mutate before batch export — so customers can wire any
//      redaction policy they need without forking the SDK.

export type Redactor = (text: string) => string;

// Sensible-default regex catch. Narrow on purpose. See header comment.
export const defaultRedactor: Redactor = (text) => {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    // Emails.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]")
    // Phone-like (very loose; intentionally false-positive-prone over false-negative).
    .replace(/\b(?:\+?\d[\d\s().-]{8,}\d)\b/g, "[redacted-phone]")
    // Common API-key prefixes (OpenAI, Slack, Stripe live, GitHub).
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b/g, "[redacted-key]");
};

export interface RedactOptions {
  captureContent: boolean;
  redact?: Redactor;
}

// Attribute key shapes that carry GenAI conversation content. The GenAI
// semantic conventions are mid-migration: some emitters use attributes
// (`gen_ai.prompt.N.content`), others use span events (`gen_ai.user.message`,
// `gen_ai.system.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`,
// `gen_ai.choice`). We handle both shapes here.

const CONTENT_ATTR_PATTERNS: RegExp[] = [
  // Standard GenAI conventions (attribute-on-span shape).
  /^gen_ai\.prompt(\.|$)/,
  /^gen_ai\.completion(\.|$)/,
  // Mastra spells the message arrays as gen_ai.input.messages /
  // gen_ai.output.messages, and tool args as gen_ai.tool.call.arguments.
  // System instructions and agent_run input/output also carry content.
  /^gen_ai\.input(\.|$)/,
  /^gen_ai\.output(\.|$)/,
  /^gen_ai\.tool\.call\.arguments$/,
  /^gen_ai\.system_instructions$/,
  /^mastra\.agent_run\.(input|output)$/,
  // Vercel AI SDK content attributes.
  /^ai\.prompt(\.|$)/,
  /^ai\.response(\.|$)/,
  /^ai\.toolCall\.args$/,
  /^ai\.toolCall\.result$/,
];

const CONTENT_EVENT_PREFIXES = [
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
  "gen_ai.choice",
];

const CONTENT_EVENT_ATTR_KEYS = ["content", "message", "tool_calls"];

function isContentAttr(key: string): boolean {
  return CONTENT_ATTR_PATTERNS.some((re) => re.test(key));
}

function isContentEvent(name: string): boolean {
  return CONTENT_EVENT_PREFIXES.some((p) => name === p || name.startsWith(`${p}.`));
}

// Mutates a writable copy of the span's attributes/events to enforce the
// content-capture policy. Designed to be called from a SpanProcessor's onEnd
// before the batch exporter sees the span.
export function applyRedactionToSpan(
  span: { attributes: Record<string, unknown>; events?: ReadableSpanEvent[] },
  opts: RedactOptions,
): void {
  const { captureContent, redact } = opts;

  // Pass 1: attributes.
  for (const key of Object.keys(span.attributes)) {
    if (!isContentAttr(key)) continue;
    if (!captureContent) {
      delete span.attributes[key];
      continue;
    }
    if (redact) {
      const v = span.attributes[key];
      if (typeof v === "string") span.attributes[key] = redact(v);
    }
  }

  // Pass 2: events.
  if (!span.events) return;
  if (!captureContent) {
    span.events = span.events.filter((e) => !isContentEvent(e.name));
    return;
  }
  if (!redact) return;
  for (const ev of span.events) {
    if (!isContentEvent(ev.name)) continue;
    if (!ev.attributes) continue;
    for (const k of CONTENT_EVENT_ATTR_KEYS) {
      const v = ev.attributes[k];
      if (typeof v === "string") ev.attributes[k] = redact(v);
    }
  }
}

// Exported so the mapper test and external users can reach the same helpers
// the SpanProcessor uses internally.
export const __internals = {
  isContentAttr,
  isContentEvent,
  CONTENT_EVENT_PREFIXES,
};
