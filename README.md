# `@agnost/sdk`

A thin TypeScript pipe that gets AI agent conversations from the
Vercel AI SDK, OpenAI SDK, and Mastra into Agnost via OpenTelemetry.

> **Status:** weekend prototype for an interview take-home. The OTel
> GenAI semantic conventions this SDK rides are themselves marked
> *Development* in the OTel spec — we bet on the direction and bridge
> the gaps today. See [docs/FINDINGS.md](./docs/FINDINGS.md) for what
> each framework actually emits in practice. The design reasoning
> behind every choice is in [REASONING.md](./REASONING.md).

---

## What it does

The SDK does exactly four things:

1. **Observe** OTel spans your framework already emits.
2. **Tag** them with identity (project, session, user, framework).
3. **Redact** content optionally — opt-in capture + pluggable hook.
4. **Ship** them to Agnost over OTLP/HTTP, with retry/backoff that
   **never throws into your host agent**.

Everything else (conversation stitching, intent extraction, clustering,
evals, dashboards) lives server-side, where it can iterate without a
customer redeploy.

---

## Running this repo locally

`@agnost/sdk` is **not published to npm** — this is a take-home
prototype. To run the demo:

```bash
git clone <this-repo>
cd agnost-sdk
npm install                          # uses .npmrc (legacy-peer-deps)
cp .env.example .env                 # add OPENAI_API_KEY (Groq key works)
npm test                             # 38 tests, including the proof artifact
```

The import paths in the snippets below (`@agnost/sdk/vercel`, etc.)
show the **intended public API** when this is eventually published.
While running from the cloned repo, replace them with relative paths
into `src/` for live experimentation — or use `npm link` to consume
this checkout as if it were `@agnost/sdk` in another project.

```bash
export AGNOST_API_KEY=...
```

### Vercel AI SDK

```ts
import { instrument, telemetry } from "@agnost/sdk/vercel";
import { generateText } from "ai";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-app",
  captureContent: true,
});

await generateText({
  model: ...,
  prompt: "...",
  experimental_telemetry: telemetry({ captureContent: true }),
});
```

### Mastra

```ts
import { instrument, OtelBridge } from "@agnost/sdk/mastra";
import { Observability } from "@mastra/observability";
import { Mastra } from "@mastra/core";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-app",
  captureContent: true,
});

new Mastra({
  agents: { myAgent },
  observability: new Observability({
    configs: {
      default: { serviceName: "my-app", bridge: new OtelBridge() },
    },
  }),
});
```

### OpenAI SDK

```ts
import { instrument, wrapOpenAI } from "@agnost/sdk/openai";
import OpenAI from "openai";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-app",
  captureContent: true,
});

const openai = wrapOpenAI(new OpenAI());
// ... use `openai` normally; chat.completions.create now emits spans.
```

### Don't know which to wire? Ask:

```bash
# Locally (in this repo):
npm run init

# Once published, the same code would ship as:
#   npx @agnost/init
```

Reads your `package.json`, prints the matching snippet. Lean by design
— no codemod, no file mutation.

---

## End-to-end demo (after `npm install`)

### Live Mastra demo — full pipeline against a real agent

`npm run demo:mastra` runs a real Mastra weather-agent against Groq
(free) with spans flowing through the actual `instrument()` pipe →
mock-ingest server → viewer. Both seams (`invoke_agent`, `chat`,
`execute_tool`) render with real model/tokens/latency. Two passes:
content visible, then redaction on — same PII question fired twice
to make the privacy story visible rather than silent.

```bash
# Make sure .env has OPENAI_API_KEY (Groq key works), OPENAI_BASE_URL,
# AGNOST_CAPTURE_MODEL — see .env.example.

# Terminal 1 — mock Agnost backend + pretty terminal viewer:
npm run ingest | npm run view

# Terminal 2 — fire the agent:
npm run demo:mastra
```

The viewer hides framework-internal lifecycle spans (Mastra's
`model_step`, `model_chunk`, etc., which correctly map to
operation `"other"`) by default — they're useful for debugging
but flood the headline. Use `npm run view:all` to see every span
including the suppressed internal ones (the data layer is always
lossless; only the renderer filters).

Transport failures log to stderr and are non-fatal by design — the
agent completes regardless. If the mock server isn't running, the
demo's spans get dropped with a quiet `[agnost] export failed` log,
the agent still produces its model output, and the process exits
cleanly. That's the SDK's never-throw invariant working as designed,
not an error.

### Capture-script demos (fixture generation)

The capture scripts hit a real provider and dump the spans they emit
to `test/fixtures/*.spans.json`, then feed them through the same
mapper the SDK uses:

```bash
npm run capture:openai     # or capture:vercel / capture:mastra
```

These are how the mapper test's "proof artifact" fixtures get
produced. Re-run them when the GenAI conventions shift.

For the minimal end-to-end SDK loop (instrument → batch exporter →
mock ingest → mapper → viewer) without any agent framework, see
`test/e2e.ts`.

---

## Privacy posture

- `captureContent` defaults to **false**. Content is *stripped* from
  spans before export — not redacted to a placeholder, removed entirely.
- When you turn it on, you can pass a `redact: (text) => text` hook
  that runs on every content string before it leaves the process.
- The bundled `defaultRedactor` is a structured-PII catch only — it
  matches emails, phone-shaped digits, and common API-key prefixes.
  It is **not** a full PII solution. Production deployments should
  supply their own redactor; the point is the hook at the right seam.

---

## Tests

```bash
npm test
```

Runs 38 tests across four files:

| File | What it proves |
| --- | --- |
| `test/mapper.test.ts` | Real captured spans from all three frameworks map to identical canonical shape via one function. **The proof artifact for the architecture.** |
| `test/transport.test.ts` | OTLP exporter retries on 5xx, gives up cleanly, never throws on unreachable endpoint. |
| `test/redact.test.ts` | Content-capture gate strips all framework content paths; pluggable redactor fires at the seam. |
| `test/degradation.test.ts` | PRD §7 invariant: host process survives Agnost-down with zero uncaught exceptions or unhandled rejections. |

The mapper fixtures are real OTel spans captured from each framework
hitting a live provider, not hand-written. Re-capture with
`npm run capture:openai|vercel|mastra` if conventions shift.

---

## What this SDK explicitly does NOT do (this weekend)

- No conversation stitching, intent extraction, clustering, sentiment,
  or evals — those happen server-side per the architecture.
- No codemod / AST rewriting from `npx @agnost/init` — it prints a
  snippet for you to paste.
- No Python SDK.
- No sampling / cost controls — handled server-side when cost actually bites.
- No MCP server for agent self-analytics.

All of these live in [REASONING.md](./REASONING.md) §"month, not weekend."

---

## License

MIT (assumed for the prototype).
