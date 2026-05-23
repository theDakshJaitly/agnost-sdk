// Live Mastra demo. Runs a real weather-agent against Groq with spans
// flowing through the actual `instrument()` pipe → mock-ingest server
// → viewer. Two passes, second one with redaction on, to make the
// privacy story visible rather than silent.
//
// Run in two terminals:
//   T1:  npm run ingest | npm run view
//   T2:  npm run demo:mastra
//
// Env (already in .env.example): OPENAI_API_KEY, OPENAI_BASE_URL,
// AGNOST_CAPTURE_MODEL. Works against any OpenAI-compatible endpoint;
// the default is a Groq-hosted Qwen model because it gives the
// cleanest tool-result → final-answer loop in the free tier.

import { instrument, mastraObservability } from "../src/profiles/mastra.js";
import { defaultRedactor } from "../src/core/redact.js";
import { buildWeatherAgent } from "./mastra-agent.js";

// ──────────────────────────────────────────────────────────────────
// Redaction: runtime-swappable policy at the SDK's fixed redact seam.
// One instrument() call, one redactor reference; the demo flips a
// local flag between passes. This is the actual point of the seam —
// callers change redaction behavior without re-instrumenting.
// ──────────────────────────────────────────────────────────────────
let redactionOn = false;
const closureRedactor = (text: string): string =>
  redactionOn ? defaultRedactor(text) : text;

// ──────────────────────────────────────────────────────────────────
// Ordering rule (critical): instrument() must register the global
// tracer provider BEFORE @mastra/otel-bridge is constructed. The
// bridge captures the global tracer eagerly in a class field
// initializer (see node_modules/@mastra/otel-bridge/dist/index.js),
// so a reversed order would silently bind it to the no-op tracer
// and the viewer would render nothing.
// ──────────────────────────────────────────────────────────────────
const handle = instrument({
  apiKey: "demo-key", // mock server doesn't validate
  endpoint: process.env["AGNOST_ENDPOINT"] ?? "http://127.0.0.1:4318",
  serviceName: "agnost-demo-mastra",
  // captureContent defaults to false in real usage — content capture
  // is opt-in, and even when on, PII passes through the redaction
  // seam before export. The demo turns it on explicitly so you can
  // see data flowing AND see redaction working in pass 2.
  captureContent: true,
  redact: closureRedactor,
});

const MODEL = process.env["AGNOST_CAPTURE_MODEL"] ?? "qwen/qwen3-32b";
const { agent, mastra } = buildWeatherAgent({
  model: MODEL,
  serviceName: "agnost-demo-mastra",
});
void mastra; // side-effectful observability registration

// ── Tiny ANSI helpers for the stderr banner; viewer stays untouched.
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const stderr = (s: string): void => process.stderr.write(s + "\n");

function divider(label: string): void {
  stderr(`\n${BOLD}─── ${label} ───${RESET}`);
}

async function ask(label: string, prompt: string): Promise<void> {
  stderr(`${DIM}[demo] ${label}: ${prompt}${RESET}`);
  try {
    // maxSteps keeps the real agent loop bounded. Some Groq-hosted
    // Llama runs repeat tool calls or fail provider-side tool parsing;
    // the viewer should surface that trace honestly without letting the
    // demo burn tokens indefinitely.
    await agent.generate(prompt, { maxSteps: 2 });
  } catch (err) {
    // Never let a model error crash the demo — same posture as the
    // SDK's never-throw invariant. Log and continue so the next
    // question still fires and the redaction beat still lands.
    stderr(`${DIM}[demo] model error (continuing): ${err instanceof Error ? err.message : String(err)}${RESET}`);
  }
  // Flush per-turn so the viewer renders this question's spans
  // before the next one starts streaming. The BatchSpanProcessor
  // is off the hot path; without an explicit flush, batched spans
  // can sit in memory long enough to scramble the visual ordering.
  await handle.flush();
}

async function main(): Promise<void> {
  stderr(`${DIM}agnost · live ingest${RESET}`);
  stderr(
    `${DIM}captureContent defaults to OFF in real usage; demo enables it to show data flowing.${RESET}`,
  );

  divider("pass 1: content visible");
  await ask("Q1", "What's the weather in Paris today?");
  await ask(
    "Q2",
    "Email me the forecast for Tokyo at jane.doe@example.com.",
  );
  await ask("Q3", "Thanks — is it warmer in London?");

  divider("pass 2: redaction on");
  redactionOn = true;
  await ask(
    "Q2 (re-fire with redactor)",
    "Email me the forecast for Tokyo at jane.doe@example.com.",
  );

  // Clean shutdown drains any remaining batched spans.
  await handle.shutdown();
  stderr(`${DIM}[demo] done${RESET}`);
}

main().catch((err) => {
  stderr(`[demo] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
