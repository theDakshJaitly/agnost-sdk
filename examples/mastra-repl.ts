// Interactive Mastra demo. Run the mock ingest/viewer in one terminal:
//
//   npm run ingest | npm run view
//
// Then run this in another:
//
//   npm run demo:mastra:repl
//
// Each submitted line goes through the same real Mastra agent and
// Agnost telemetry pipe as the fixed demo, then flushes immediately so
// the viewer updates turn-by-turn.

import { createInterface } from "node:readline/promises";
import { stdin as input, stderr, stdout } from "node:process";
import { createMastraDemoRunner } from "./mastra-demo-runner.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const FG_GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function write(line: string): void {
  stderr.write(line + "\n");
}

async function question(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string | undefined> {
  try {
    return await rl.question(prompt);
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: unknown }).code === "ERR_USE_AFTER_CLOSE"
    ) {
      return undefined;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const runner = createMastraDemoRunner();
  const rl = createInterface({ input, output: stdout });
  let turn = 1;

  write(`${DIM}agnost · interactive ingest${RESET}`);
  write(`${DIM}type a prompt, /redact on, /redact off, /exit, or Ctrl-D${RESET}`);
  write(`${DIM}captureContent is ON for the demo; redaction starts OFF.${RESET}`);

  try {
    while (true) {
      const line = await question(rl, `${BOLD}you>${RESET} `);
      if (line === undefined) break;
      const prompt = line.trim();
      if (!prompt) continue;

      if (prompt === "/exit" || prompt === "/quit") break;
      if (prompt === "/redact on") {
        runner.setRedaction(true);
        write(`${DIM}[demo] redaction on${RESET}`);
        continue;
      }
      if (prompt === "/redact off") {
        runner.setRedaction(false);
        write(`${DIM}[demo] redaction off${RESET}`);
        continue;
      }

      const answer = await runner.ask(`turn ${turn}`, prompt);
      if (answer) {
        stdout.write(`${FG_GREEN}${BOLD}assistant>${RESET} ${answer.trim()}\n`);
      }
      turn += 1;
    }
  } finally {
    rl.close();
    await runner.shutdown();
    write(`${DIM}[demo] done${RESET}`);
  }
}

main().catch((err) => {
  stderr.write(`[demo] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
