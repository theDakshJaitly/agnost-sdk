// Terminal pretty-printer for canonical events. Reads NDJSON from stdin
// (the mock-ingest server's stdout) and renders each event as a grouped
// terminal block, conversation by conversation.
//
//   npm run ingest | npm run view
//
// Defaults to hiding operation="other" events because frameworks emit
// internal lifecycle spans (Mastra's model_step, model_chunk, etc.)
// that correctly map to "other" but drown out the meaningful chat /
// invoke_agent / execute_tool signal. The data layer (server NDJSON)
// stays lossless; only the rendering filters. Pass --all to see every
// event, including the internal lifecycle markers.
//
// No external dependencies — uses ANSI color codes directly.

import { createInterface } from "node:readline";
import type { CanonicalEvent } from "../src/core/schema.js";

const SHOW_ALL = process.argv.includes("--all");
const FLUSH_DELAY_MS = 150;
const RULE = "─".repeat(72);

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const FG = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
} as const;

const seenConversations = new Set<string>();
let renderedConversations = 0;
let renderedSpans = 0;

function opColor(op: CanonicalEvent["operation"]): string {
  switch (op) {
    case "chat":
      return FG.cyan;
    case "invoke_agent":
      return FG.magenta;
    case "execute_tool":
      return FG.yellow;
    case "embeddings":
      return FG.blue;
    default:
      return FG.gray;
  }
}

function header(e: CanonicalEvent, depth = 0): string {
  const color = opColor(e.operation);
  const cid = e.conversation_id.slice(0, 8);
  const seenBefore = seenConversations.has(e.conversation_id);
  const marker = !seenBefore && depth === 0 ? `${BOLD}┌${RESET}` : `${DIM}↳${RESET}`;
  seenConversations.add(e.conversation_id);
  // Omit model/provider entirely when the span legitimately doesn't
  // carry them (Mastra's invoke_agent / execute_tool spans only put
  // model attrs on the inner chat span). Showing "no-model" reads as
  // a bug rather than as "this span correctly has no model dimension."
  const meta = [
    e.framework,
    e.model,
    e.provider,
    `${e.latency_ms.toFixed(0)}ms`,
    e.input_tokens !== undefined ? `in:${e.input_tokens}` : undefined,
    e.output_tokens !== undefined ? `out:${e.output_tokens}` : undefined,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" · ");
  const op = `${color}${BOLD}${e.operation}${RESET}`;
  const dimMeta = [meta, `conv=${cid}`].filter(Boolean).join("  ");
  return `${marker} ${op}${dimMeta ? `  ${DIM}${dimMeta}${RESET}` : ""}`;
}

function body(e: CanonicalEvent, depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth + 1);
  const finishReasons = finishReasonsOf(e);
  const errorMessage = errorMessageOf(e);
  if (finishReasons.includes("error") || errorMessage) {
    lines.push(
      `${indent}${FG.red}error${RESET}     ${errorMessage ?? `finish=${finishReasons.join(",")}`}`,
    );
  }
  for (const t of e.turns ?? []) {
    if (t.role === "system") continue;
    const role = t.role.padEnd(9);
    const content = (t.content ?? "").trim().replace(/\s+/g, " ");
    const truncated = content.length > 120 ? content.slice(0, 117) + "…" : content;
    if (truncated) lines.push(`${indent}${DIM}${role}${RESET} ${truncated}`);
  }
  for (const tc of e.tool_calls ?? []) {
    const args = tc.arguments ? tc.arguments.slice(0, 80) : "";
    lines.push(`${indent}${FG.yellow}tool→${RESET}     ${BOLD}${tc.name}${RESET}(${DIM}${args}${RESET})`);
    if (tc.result) {
      const result = tc.result.slice(0, 80);
      lines.push(`${indent}${FG.green}result${RESET}    ${result}`);
    }
  }
  return lines.join("\n");
}

function finishReasonsOf(e: CanonicalEvent): string[] {
  const raw = e.raw_otel_attrs["gen_ai.response.finish_reasons"];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [raw];
  }
}

function errorMessageOf(e: CanonicalEvent): string | undefined {
  const raw = e.raw_otel_attrs["error.message"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

interface ConversationBuffer {
  events: CanonicalEvent[];
  timer?: NodeJS.Timeout;
}

const buffers = new Map<string, ConversationBuffer>();

function startedAt(e: CanonicalEvent): number {
  const parsed = Date.parse(e.ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function endedAt(e: CanonicalEvent): number {
  return startedAt(e) + e.latency_ms;
}

function operationRank(e: CanonicalEvent): number {
  switch (e.operation) {
    case "invoke_agent":
      return 0;
    case "chat":
      return 1;
    case "execute_tool":
      return 2;
    case "embeddings":
      return 3;
    default:
      return 4;
  }
}

function compareEvents(a: CanonicalEvent, b: CanonicalEvent): number {
  const byStart = startedAt(a) - startedAt(b);
  if (byStart !== 0) return byStart;
  const byRank = operationRank(a) - operationRank(b);
  if (byRank !== 0) return byRank;
  return a.turn_id.localeCompare(b.turn_id);
}

function inferredParent(child: CanonicalEvent, candidates: CanonicalEvent[]): CanonicalEvent | undefined {
  const start = startedAt(child);
  const end = endedAt(child);
  return candidates
    .filter((e) => e.turn_id !== child.turn_id && startedAt(e) <= start && endedAt(e) >= end)
    .sort((a, b) => {
      // Prefer the narrowest containing span, with invoke_agent still
      // winning as the top-level frame when parent IDs are unavailable.
      const rank = operationRank(a) - operationRank(b);
      if (rank !== 0 && (a.operation === "invoke_agent" || b.operation === "invoke_agent")) return rank;
      return a.latency_ms - b.latency_ms;
    })[0];
}

function renderHeader(e: CanonicalEvent, depth: number): void {
  const prefix = "  ".repeat(depth);
  process.stdout.write(prefix + header(e, depth) + "\n");
  const b = body(e, depth);
  if (b) process.stdout.write(b + "\n");
}

function renderTree(events: CanonicalEvent[]): void {
  if (events.length === 0) return;

  const visible = SHOW_ALL ? events : events.filter((e) => e.operation !== "other");
  const otherCount = SHOW_ALL ? 0 : events.length - visible.length;
  if (visible.length === 0 && otherCount === 0) return;
  if (renderedConversations > 0) process.stdout.write(`\n${DIM}${RULE}${RESET}\n\n`);
  renderedConversations += 1;
  renderedSpans += events.length;

  const sorted = [...visible].sort(compareEvents);
  const ids = new Set(sorted.map((e) => e.turn_id));
  const children = new Map<string, CanonicalEvent[]>();
  const roots: CanonicalEvent[] = [];

  for (const event of sorted) {
    const parentId =
      event.parent_turn_id && ids.has(event.parent_turn_id)
        ? event.parent_turn_id
        : inferredParent(event, sorted)?.turn_id;

    if (!parentId) {
      roots.push(event);
      continue;
    }

    const bucket = children.get(parentId) ?? [];
    bucket.push(event);
    children.set(parentId, bucket);
  }

  for (const bucket of children.values()) bucket.sort(compareEvents);
  roots.sort((a, b) => {
    const byRank = operationRank(a) - operationRank(b);
    if (byRank !== 0) return byRank;
    return compareEvents(a, b);
  });

  const seen = new Set<string>();
  const walk = (event: CanonicalEvent, depth: number): void => {
    if (seen.has(event.turn_id)) return;
    seen.add(event.turn_id);
    renderHeader(event, depth);
    for (const child of children.get(event.turn_id) ?? []) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);
  for (const event of sorted) walk(event, 0);

  if (otherCount > 0) {
    const cid = events[0]?.conversation_id.slice(0, 8) ?? "unknown";
    process.stdout.write(
      `  ${DIM}⋯ ${otherCount} internal span${otherCount === 1 ? "" : "s"} elided  (conv=${cid})${RESET}\n`,
    );
  }
}

function flushConversation(conversationId: string): void {
  const buffer = buffers.get(conversationId);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  buffers.delete(conversationId);
  renderTree(buffer.events);
}

function scheduleFlush(conversationId: string): void {
  const buffer = buffers.get(conversationId);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => flushConversation(conversationId), FLUSH_DELAY_MS);
}

const rl = createInterface({ input: process.stdin });
process.stderr.write(`${DIM}[viewer] waiting for events on stdin…${RESET}\n`);

rl.on("line", (line) => {
  if (!line.trim()) return;
  let e: CanonicalEvent;
  try {
    e = JSON.parse(line);
  } catch {
    // Silently ignore non-JSON lines (e.g. npm script banner output
    // that leaks into the pipe before the server starts).
    return;
  }

  const buffer = buffers.get(e.conversation_id) ?? { events: [] };
  buffer.events.push(e);
  buffers.set(e.conversation_id, buffer);
  scheduleFlush(e.conversation_id);
});

rl.on("close", () => {
  for (const conversationId of [...buffers.keys()]) flushConversation(conversationId);
  if (renderedConversations > 0) {
    process.stderr.write(
      `${DIM}agnost · ${renderedConversations} conversation${renderedConversations === 1 ? "" : "s"} · ${renderedSpans} span${renderedSpans === 1 ? "" : "s"}${RESET}\n`,
    );
  }
  process.exit(0);
});
