# `@agnost/sdk`

A thin TypeScript OpenTelemetry pipe that gets agent-framework telemetry into Agnost with near-zero friction: observe, tag, redact, ship.

`@agnost/sdk` is not a capture library. The frameworks already emit the useful spans; the job here is to ask developers for the smallest possible integration surface, keep Agnost out of the model-request hot path, preserve raw OTel as the ground-truth asset, and leave interpretation — stitching, clustering, intent, evals, dashboards — server-side where it can evolve without customer redeploys.

`4 frameworks · 44 tests passing · TypeScript`

> Weekend prototype for an interview take-home. OTel GenAI semantic conventions are still marked Development; this repo bets on the direction and documents the current gaps.

## Divergence Report

![Divergence report: four frameworks, one mapper](assets/divergence-report.jpg)

Four frameworks normalized by one mapper — zero spans fell through unrecognized, and each new framework cost less than the last.

The report is generated from real captured fixtures via `npm run divergence-report`, then mapped through the actual `spanToCanonical` implementation. Vercel forced the generic tables into existence; Mastra exercised richer agent lifecycle spans; OpenAI is the clean baseline; LangGraph reused the same machinery with near-zero new shape work.

## Live Viewer

![Live agent loop in the viewer](assets/live-viewer.png)

A real Mastra agent loop captured live — invoke_agent → chat → execute_tool, flowing through the SDK into the viewer.

The demo runs a real agent against a real model, then sends live OTel through the SDK into the mock ingest server and terminal viewer. It shows both seams Agnost cares about: inference spans (`chat`) and agent-loop behavior (`invoke_agent`, `execute_tool`).

## Quickstart

`@agnost/sdk` is **not published to npm** yet. Run it from this repo. The current prototype is tested on Node `v22`; `npm install` uses the repo's `.npmrc` for peer-dependency compatibility.

```bash
git clone <this-repo>
cd agnost-sdk
npm install
cp .env.example .env
npm test
```

Add an API key/model endpoint to `.env`. Groq's OpenAI-compatible endpoint works with the included examples.

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
AGNOST_CAPTURE_MODEL=qwen/qwen3-32b
```

The intended public API looks like this:

```ts
import { instrument } from "@agnost/sdk/mastra";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-agent",
  captureContent: true,
});
```

Run the live viewer in two terminals:

```bash
# Terminal 1 — mock Agnost backend + terminal viewer
npm run ingest | npm run view
```

```bash
# Terminal 2 — real Mastra agent demo
npm run demo:mastra
```

Optional interactive mode:

```bash
npm run demo:mastra:repl
```

LangGraph demo and fixture capture use Python through `uv` because the verified path is Python LangGraph with `langchain-azure-ai`:

```bash
npm run demo:langgraph
npm run capture:langgraph
```

## Onboarding

`agnost-init` detects the framework from `package.json` and prints the right wiring snippet. It is deliberately a guide, not a codemod.

![agnost-init framework detection](assets/agnost-init.png)

```bash
npm run init
```

## Content & Privacy

![Redaction: PII captured then scrubbed](assets/redaction-before-after.png)

Content capture is opt-in; when on, PII passes through a redaction seam before export — same conversation, before and after.

`captureContent` defaults to `false`, which strips content-bearing attributes and events before export. Redaction is the one deliberate client-side step, because data cannot be scrubbed after it has already left the customer's process.

## Supported Frameworks

| Framework | Honest support path |
| --- | --- |
| Vercel AI SDK | Uses `experimental_telemetry` plus `@agnost/sdk/vercel`; Vercel emits wrapper/tool spans that the mapper normalizes through tables. |
| Mastra | Uses `@mastra/otel-bridge` via `@agnost/sdk/mastra`; the live demo shows `invoke_agent`, `chat`, and `execute_tool` spans. |
| OpenAI SDK | Uses `wrapOpenAI` from `@agnost/sdk/openai`; OpenAI itself does not run tools, so the fixture emits a separate tool span for the agent seam. |
| LangGraph | Verified with Python LangGraph plus `langchain-azure-ai`'s `AzureAIOpenTelemetryTracer`; not the LangSmith/OpenLLMetry path, and not claimed as automatic out-of-the-box support. |

## Architecture

![Architecture: thin client, server-side brains](assets/architecture.svg)

The client does four things — observe, tag, redact, ship. All interpretation lives server-side.

For the deeper reasoning, see [docs/REASONING.md](docs/REASONING.md).

## Docs & Artifacts

- [docs/REASONING.md](docs/REASONING.md) — the architecture and tradeoffs.
- [docs/FINDINGS.md](docs/FINDINGS.md) — per-framework divergence narrative.
- [DIVERGENCE.md](DIVERGENCE.md) — generated mechanical breakdown from real fixtures.
- [docs/DEMO_SPEC.md](docs/DEMO_SPEC.md) — live demo build notes.

`DIVERGENCE.md` is generated by:

```bash
npm run divergence-report
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm test` | Runs the 44-test suite. |
| `npm run typecheck` | TypeScript typecheck only. |
| `npm run build` | Builds `dist/`. |
| `npm run ingest` | Starts the mock OTLP ingest server. |
| `npm run view` | Pretty-prints canonical events from stdin. |
| `npm run demo:mastra` | Runs the live Mastra demo. |
| `npm run demo:mastra:repl` | Runs the interactive Mastra demo. |
| `npm run demo:langgraph` | Runs the LangGraph Azure-tracer demo via `uv`. |
| `npm run divergence-report` | Regenerates `DIVERGENCE.md` from fixtures. |
| `npm run init` | Prints framework-specific onboarding snippets. |

## License

MIT (assumed for the prototype).
