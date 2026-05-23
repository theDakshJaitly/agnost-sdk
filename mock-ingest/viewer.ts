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

function header(e: CanonicalEvent): string {
  const color = opColor(e.operation);
  const cid = e.conversation_id.slice(0, 8);
  const seenBefore = seenConversations.has(e.conversation_id);
  const marker = seenBefore ? `${DIM}↳${RESET}` : `${BOLD}┌${RESET}`;
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
  return `${marker} ${color}${BOLD}${e.operation}${RESET}  ${DIM}conv=${cid}${RESET}  ${meta}`;
}

function body(e: CanonicalEvent): string {
  const lines: string[] = [];
  for (const t of e.turns ?? []) {
    const role = t.role.padEnd(9);
    const content = (t.content ?? "").trim().replace(/\s+/g, " ");
    const truncated = content.length > 120 ? content.slice(0, 117) + "…" : content;
    lines.push(`  ${DIM}${role}${RESET} ${truncated}`);
  }
  for (const tc of e.tool_calls ?? []) {
    const args = tc.arguments ? tc.arguments.slice(0, 80) : "";
    lines.push(`  ${FG.yellow}tool→${RESET}     ${BOLD}${tc.name}${RESET}(${DIM}${args}${RESET})`);
    if (tc.result) {
      const result = tc.result.slice(0, 80);
      lines.push(`  ${FG.green}result${RESET}    ${result}`);
    }
  }
  return lines.join("\n");
}

// Tally suppressed "other" events per conversation and flush a single
// dim summary when we move on to the next conversation — so the user
// sees "stuff happened" without the noise. State is per-conversation
// because events for one trace arrive contiguously in our pipeline
// (the demo's per-question flush guarantees that).
let pendingConv: string | undefined;
let pendingOtherCount = 0;

function flushPendingSummary(): void {
  if (pendingConv && pendingOtherCount > 0) {
    const cid = pendingConv.slice(0, 8);
    process.stdout.write(
      `  ${DIM}⋯ ${pendingOtherCount} internal span${pendingOtherCount === 1 ? "" : "s"} elided  (conv=${cid})${RESET}\n`,
    );
  }
  pendingConv = undefined;
  pendingOtherCount = 0;
}

const rl = createInterface({ input: process.stdin });
process.stdout.write(`${DIM}[viewer] waiting for events on stdin…${RESET}\n`);

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

  if (!SHOW_ALL && e.operation === "other") {
    if (pendingConv !== e.conversation_id) {
      flushPendingSummary();
      pendingConv = e.conversation_id;
    }
    pendingOtherCount += 1;
    return;
  }

  if (pendingConv && pendingConv !== e.conversation_id) {
    flushPendingSummary();
  } else if (pendingConv === e.conversation_id) {
    flushPendingSummary();
  }

  process.stdout.write(header(e) + "\n");
  const b = body(e);
  if (b) process.stdout.write(b + "\n");
});

rl.on("close", () => {
  flushPendingSummary();
  process.exit(0);
});
