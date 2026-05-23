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
// AGNOST_CAPTURE_MODEL. Works against any OpenAI-compatible endpoint.

import { createMastraDemoRunner } from "./mastra-demo-runner.js";

// ── Tiny ANSI helpers for the stderr banner; viewer stays untouched.
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const stderr = (s: string): void => process.stderr.write(s + "\n");

function divider(label: string): void {
  stderr(`\n${BOLD}─── ${label} ───${RESET}`);
}

async function main(): Promise<void> {
  const runner = createMastraDemoRunner();
  stderr(`${DIM}agnost · live ingest${RESET}`);
  stderr(
    `${DIM}captureContent defaults to OFF in real usage; demo enables it to show data flowing.${RESET}`,
  );

  divider("pass 1: content visible");
  await runner.ask("Q1", "What's the weather in Paris today?");
  await runner.ask(
    "Q2",
    "Email me the forecast for Tokyo at jane.doe@example.com.",
  );
  await runner.ask("Q3", "Thanks — is it warmer in London?");

  divider("pass 2: redaction on");
  runner.setRedaction(true);
  await runner.ask(
    "Q2 (re-fire with redactor)",
    "Email me the forecast for Tokyo at jane.doe@example.com.",
  );

  // Clean shutdown drains any remaining batched spans.
  await runner.shutdown();
  stderr(`${DIM}[demo] done${RESET}`);
}

main().catch((err) => {
  stderr(`[demo] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
