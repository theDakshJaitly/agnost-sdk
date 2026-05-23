#!/usr/bin/env node
// `npx @agnost/init` — detect the framework and print the paste-ready
// instrument() snippet. Intentionally lean: no file edits, no AST
// rewriting. The user reads what we detected and copy-pastes the
// snippet themselves. Codemod is "month, not weekend" per PRD §10.

import { detect } from "./detect.js";
import { snippetFor } from "./snippets.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const FG_GREEN = "\x1b[32m";
const FG_YELLOW = "\x1b[33m";
const FG_RED = "\x1b[31m";

function main(): number {
  const result = detect();

  if (!result.primary) {
    process.stderr.write(
      `${FG_RED}[agnost-init]${RESET} Could not detect a supported framework in ${DIM}${result.packageJsonPath}${RESET}.\n` +
        `Supported: @mastra/core, ai (Vercel AI SDK), openai. Install one and rerun.\n`,
    );
    return 1;
  }

  const others = result.detected.slice(1);
  process.stdout.write(
    `${FG_GREEN}[agnost-init]${RESET} Detected ${BOLD}${result.primary}${RESET}` +
      (others.length > 0
        ? ` ${DIM}(also saw: ${others.join(", ")} — using ${result.primary} since it's the agent-author seam)${RESET}`
        : "") +
      `\n\n` +
      `${FG_YELLOW}Paste this into your app entry point:${RESET}\n\n` +
      snippetFor(result.primary) +
      `\n` +
      `${DIM}Need a different framework? Pass --framework=vercel|mastra|openai.${RESET}\n`,
  );
  return 0;
}

const argv = process.argv.slice(2);
const flagFw = argv.find((a) => a.startsWith("--framework="))?.split("=")[1];
if (flagFw === "vercel" || flagFw === "mastra" || flagFw === "openai") {
  process.stdout.write(snippetFor(flagFw));
  process.exit(0);
}

process.exit(main());
