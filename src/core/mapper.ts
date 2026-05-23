import { attrsToIdentity } from "./identity.js";
import type {
  CanonicalEvent,
  ConversationTurn,
  HrTime,
  OperationKind,
  ReadableSpanLike,
  ReadableSpanEvent,
  ToolCall,
} from "./schema.js";

// Single normalizer. Reads only OpenTelemetry GenAI semantic conventions
// — plus a small set of well-defined attribute aliases for frameworks
// that emit equivalent signals under their own names. No framework
// branches in the consuming code; all variation lives in the three
// tables below.
//
// The data-driven shape is the design's defense of "one mapper" against
// the reality that OTel GenAI conventions are still stabilizing in 2026.
// As frameworks adopt the standard, entries in these tables shrink. The
// code that consumes them stays unchanged.
//
// See docs/FINDINGS.md for the concrete divergences observed per
// framework — that doc is the evidence backing every alias here.

// --- Table 1: span-name → operation kind ------------------------------
// Ordered most-specific first. The first match wins. Only ever consulted
// when `gen_ai.operation.name` is absent.
const OPERATION_NAME_PATTERNS: { pattern: RegExp; op: OperationKind }[] = [
  // Vercel AI SDK inner inference spans must match before the outer
  // wrapper, or both flatten to "chat" and we double-count.
  { pattern: /^ai\.generateText\.doGenerate$/, op: "chat" },
  { pattern: /^ai\.streamText\.doStream$/, op: "chat" },
  // Vercel agent-loop wrappers. Emitted as a parent span that bundles
  // multiple doGenerate calls + toolCalls. Treated as invoke_agent so a
  // canonical event is produced for trace linkage but NO turns and NO
  // token counts are derived from it (avoiding the duplicate).
  { pattern: /^ai\.generateText$/, op: "invoke_agent" },
  { pattern: /^ai\.streamText$/, op: "invoke_agent" },
  { pattern: /^ai\.toolCall$/, op: "execute_tool" },
  // Standard GenAI-convention span name prefixes.
  { pattern: /^chat(\s|$)/, op: "chat" },
  { pattern: /^embeddings(\s|$)/, op: "embeddings" },
  { pattern: /^invoke_agent(\s|$)/, op: "invoke_agent" },
  { pattern: /^execute_tool(\s|$)/, op: "execute_tool" },
];

// --- Table 2: attribute aliases ---------------------------------------
// Canonical key → list of alternate keys, checked in order. The first
// non-undefined value wins. `gen_ai.provider.name` is Mastra's spelling
// of what OpenAI's conventions call `gen_ai.system`.
const ATTRIBUTE_ALIASES: Record<string, string[]> = {
  "gen_ai.request.model": ["ai.model.id"],
  "gen_ai.response.model": ["ai.response.model"],
  "gen_ai.system": ["gen_ai.provider.name", "ai.model.provider"],
  "gen_ai.usage.input_tokens": ["ai.usage.inputTokens"],
  "gen_ai.usage.output_tokens": ["ai.usage.outputTokens"],
};

// --- Table 3: provider value normalization ----------------------------
// Some frameworks lie in `gen_ai.system` with their internal namespace
// (e.g. Vercel emits "openai.responses"). We collapse those to the real
// provider name. Pattern: `<provider>.<framework-internal-suffix>`.
const FRAMEWORK_INTERNAL_SUFFIXES = new Set([
  "responses",
  "chat",
  "completion",
  "completions",
  "embeddings",
]);

function normalizeProvider(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const dot = raw.indexOf(".");
  if (dot === -1) return raw;
  const head = raw.slice(0, dot);
  const tail = raw.slice(dot + 1);
  if (FRAMEWORK_INTERNAL_SUFFIXES.has(tail)) return head;
  return raw;
}

// --- Tool-attribute aliases (used only when operation is execute_tool) -
const TOOL_NAME_KEYS = ["gen_ai.tool.name", "ai.toolCall.name"];
const TOOL_ARGS_ATTR_KEYS = ["gen_ai.tool.call.arguments", "ai.toolCall.args"];
const TOOL_RESULT_KEYS = ["gen_ai.tool.result", "ai.toolCall.result"];

// =====================================================================
// Helpers
// =====================================================================

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// Read a canonical attribute by name OR any of its aliases. Order is
// canonical-first so a framework that emits both standard and internal
// names always resolves to the standard value.
function readAttr(attrs: Record<string, unknown>, canonical: string): unknown {
  if (attrs[canonical] !== undefined) return attrs[canonical];
  for (const alias of ATTRIBUTE_ALIASES[canonical] ?? []) {
    if (attrs[alias] !== undefined) return attrs[alias];
  }
  return undefined;
}

function readFirst(attrs: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (attrs[k] !== undefined) return attrs[k];
  }
  return undefined;
}

// Times in serialized OTel JSON come as HrTime [seconds, nanos]. Live
// ReadableSpan also exposes them as HrTime. Some serializers may use
// number (ms) or ISO strings; we handle all three.
function toMillis(t: ReadableSpanLike["startTime"]): number {
  if (Array.isArray(t)) {
    const [sec, nsec] = t as HrTime;
    return sec * 1000 + nsec / 1e6;
  }
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoTs(t: ReadableSpanLike["startTime"]): string {
  return new Date(toMillis(t)).toISOString();
}

function pickOperation(attrs: Record<string, unknown>, name: string): OperationKind {
  const op = asString(attrs["gen_ai.operation.name"]);
  if (op === "chat") return "chat";
  if (op === "invoke_agent") return "invoke_agent";
  if (op === "execute_tool") return "execute_tool";
  if (op === "embeddings") return "embeddings";
  for (const { pattern, op: kind } of OPERATION_NAME_PATTERNS) {
    if (pattern.test(name)) return kind;
  }
  return "other";
}

function getSpanContext(span: ReadableSpanLike): { traceId: string; spanId: string } {
  if (typeof span.spanContext === "function") {
    try {
      return span.spanContext();
    } catch {
      // fall through to flat fields
    }
  }
  return { traceId: span.traceId ?? "", spanId: span.spanId ?? "" };
}

// Defensive parse helper. Never throws; on malformed input returns the
// fallback. Keeps the never-crash invariant for any JSON-encoded
// attribute payloads we may receive from frameworks.
function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// =====================================================================
// Turn extraction
// =====================================================================

const MESSAGE_EVENT_NAMES = new Set([
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
]);

function eventToTurn(ev: ReadableSpanEvent): ConversationTurn | undefined {
  if (!MESSAGE_EVENT_NAMES.has(ev.name)) return undefined;
  const attrs = ev.attributes ?? {};
  const role = asString(attrs["role"]) ?? ev.name.split(".")[1] ?? "unknown";
  const content = asString(attrs["content"]);
  return { role, content };
}

// Flatten a message-content payload to a single string. Each framework
// uses a slightly different field name for the textual body of a part:
//   Vercel:  [{ type: "text", text: "..." }]
//   Mastra:  [{ type: "text", content: "..." }]
//   String:  "..."
// We try both `text` and `content`; unknown part types fall through to
// raw_otel_attrs.
function flattenContentParts(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string") out.push(part);
    else if (part && typeof part === "object") {
      const p = part as { type?: unknown; text?: unknown; content?: unknown };
      if (p.type === "text") {
        if (typeof p.text === "string") out.push(p.text);
        else if (typeof p.content === "string") out.push(p.content);
      }
    }
  }
  return out.length > 0 ? out.join("") : undefined;
}

// Attribute-sourced turns. Used when events are empty and the operation
// is "chat". Each framework JSON-encodes a `[{role, content}]` array on
// a different attribute; the consuming code is the same. Content has
// already passed through the redaction seam (see redact.ts patterns) by
// the time the mapper sees these attributes.
//
//   Vercel: `ai.prompt.messages`        — content: string | [{type, text}]
//   Mastra: `gen_ai.input.messages`     — parts:   [{type, content}]
const MESSAGE_ATTR_KEYS = ["ai.prompt.messages", "gen_ai.input.messages"];
const ASSISTANT_OUTPUT_KEYS = ["gen_ai.output.messages"];

type RawMessage = {
  role?: unknown;
  // Vercel uses `content`; Mastra uses `parts`.
  content?: unknown;
  parts?: unknown;
};

function rawMessageToTurn(m: RawMessage): ConversationTurn {
  const role = asString(m?.role) ?? "unknown";
  const body = m?.content ?? m?.parts;
  const content = flattenContentParts(body) ?? (typeof body === "string" ? body : undefined);
  return { role, content };
}

function turnsFromMessageAttr(attrs: Record<string, unknown>): ConversationTurn[] {
  for (const key of MESSAGE_ATTR_KEYS) {
    if (attrs[key] === undefined) continue;
    const parsed = safeJsonParse<RawMessage[]>(attrs[key], []);
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    return parsed.map(rawMessageToTurn);
  }
  return [];
}

function assistantTurnFromOutputAttr(attrs: Record<string, unknown>): ConversationTurn | undefined {
  for (const key of ASSISTANT_OUTPUT_KEYS) {
    if (attrs[key] === undefined) continue;
    const parsed = safeJsonParse<RawMessage[]>(attrs[key], []);
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const turn = rawMessageToTurn(parsed[i] ?? {});
      if (turn.role === "assistant" && turn.content && turn.content.length > 0) return turn;
    }
  }
  return undefined;
}

function parseToolCallsFromChoiceEvent(ev: ReadableSpanEvent): ToolCall[] | undefined {
  const parsed = safeJsonParse<unknown>(ev.attributes?.["tool_calls"], undefined);
  if (!Array.isArray(parsed)) return undefined;
  const out: ToolCall[] = [];
  for (const tc of parsed) {
    if (tc && typeof tc === "object" && "function" in tc) {
      const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
      const name = asString(fn?.name);
      if (!name) continue;
      out.push({ name, arguments: asString(fn?.arguments) });
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseToolCallsFromVercelAttr(attrs: Record<string, unknown>): ToolCall[] | undefined {
  type RawTc = { toolName?: unknown; input?: unknown };
  const parsed = safeJsonParse<RawTc[]>(attrs["ai.response.toolCalls"], []);
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const out: ToolCall[] = [];
  for (const tc of parsed) {
    const name = asString(tc?.toolName);
    if (!name) continue;
    out.push({ name, arguments: asString(tc?.input) });
  }
  return out.length > 0 ? out : undefined;
}

// =====================================================================
// Mapper entry point
// =====================================================================

export function spanToCanonical(span: ReadableSpanLike): CanonicalEvent {
  const attrs = span.attributes ?? {};
  const ctx = getSpanContext(span);
  const operation = pickOperation(attrs, span.name);

  const startMs = toMillis(span.startTime);
  const endMs = toMillis(span.endTime);

  const model =
    asString(readAttr(attrs, "gen_ai.request.model")) ??
    asString(readAttr(attrs, "gen_ai.response.model"));
  const provider = normalizeProvider(asString(readAttr(attrs, "gen_ai.system")));
  const input_tokens = asNumber(readAttr(attrs, "gen_ai.usage.input_tokens"));
  const output_tokens = asNumber(readAttr(attrs, "gen_ai.usage.output_tokens"));

  const id = attrsToIdentity(attrs);

  // Turn + tool-call extraction is gated on operation. invoke_agent
  // wrappers (Vercel ai.generateText, Mastra invoke_agent) must NOT
  // emit turns or tokens — those belong to the inner chat span.
  const turns: ConversationTurn[] = [];
  let assistantContent: string | undefined;
  const toolCalls: ToolCall[] = [];

  if (operation === "chat") {
    // Pass 1: event-sourced turns (standard GenAI conventions path).
    for (const ev of span.events ?? []) {
      const turn = eventToTurn(ev);
      if (turn) {
        turns.push(turn);
        continue;
      }
      if (ev.name === "gen_ai.choice") {
        const content = asString(ev.attributes?.["content"]);
        const role = asString(ev.attributes?.["role"]) ?? "assistant";
        if (content) {
          assistantContent = content;
          turns.push({ role, content });
        }
        const tcs = parseToolCallsFromChoiceEvent(ev);
        if (tcs) toolCalls.push(...tcs);
      }
    }
    // Pass 2: attribute-sourced fallback when events are empty
    // (Vercel `ai.prompt.messages`, Mastra `gen_ai.input.messages`).
    if (turns.length === 0) {
      turns.push(...turnsFromMessageAttr(attrs));
    }
    // Assistant content from response attributes. Vercel uses
    // `ai.response.text`; Mastra uses `gen_ai.output.messages` (the
    // final entry is the assistant turn).
    if (!assistantContent) {
      const textResp = asString(attrs["ai.response.text"]);
      if (textResp) {
        assistantContent = textResp;
        turns.push({ role: "assistant", content: textResp });
      } else {
        const fromOutput = assistantTurnFromOutputAttr(attrs);
        if (fromOutput?.content) {
          assistantContent = fromOutput.content;
          turns.push(fromOutput);
        }
      }
    }
    // Vercel's tool calls live on the chat span as an attribute.
    if (toolCalls.length === 0) {
      const vercelToolCalls = parseToolCallsFromVercelAttr(attrs);
      if (vercelToolCalls) toolCalls.push(...vercelToolCalls);
    }
  } else if (operation === "execute_tool") {
    const name = asString(readFirst(attrs, TOOL_NAME_KEYS));
    if (name) {
      // Standard: arguments live on the `gen_ai.tool.message` event body.
      const eventArgs = asString(
        (span.events ?? []).find((e) => e.name === "gen_ai.tool.message")
          ?.attributes?.["content"],
      );
      // Vercel: arguments live on the attribute.
      const attrArgs = asString(readFirst(attrs, TOOL_ARGS_ATTR_KEYS));
      const result = asString(readFirst(attrs, TOOL_RESULT_KEYS));
      toolCalls.push({
        name,
        arguments: eventArgs ?? attrArgs,
        result,
      });
    }
  }
  // invoke_agent / embeddings / other: no turn or tool extraction.
  // The canonical event is still emitted for trace linkage, with
  // raw_otel_attrs preserved.

  return {
    conversation_id: ctx.traceId,
    turn_id: ctx.spanId,
    parent_turn_id: span.parentSpanId,
    operation,
    model,
    provider,
    role: turns[turns.length - 1]?.role,
    content: assistantContent,
    turns: turns.length > 0 ? turns : undefined,
    input_tokens,
    output_tokens,
    latency_ms: Math.max(0, endMs - startMs),
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    framework: id.framework ?? "unknown",
    service_name: id.service_name ?? "unknown",
    project_id: id.project_id,
    session_id: id.session_id || ctx.traceId,
    user_id: id.user_id,
    ts: toIsoTs(span.startTime),
    raw_otel_attrs: { ...attrs },
  };
}
