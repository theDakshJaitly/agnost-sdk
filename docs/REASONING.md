# REASONING.md — Agnost SDK (Track B)

The integration question isn't "how do we capture agent conversations." The frameworks already capture them — Vercel AI SDK, Mastra, and (via instrumentation) OpenAI all emit OpenTelemetry. The real question is **how little we can ask a developer to do to get that data flowing into Agnost, without ever putting Agnost in a position to slow or break their agent.** So this SDK is deliberately *not* a capture library. It's a thin, reliable **OTel pipe**: observe the spans the framework already emits, tag them with identity, optionally redact content, ship them out of band. Everything that interprets the data — clustering, intent, evals — lives server-side, where it can change without a customer redeploy.

The bet underneath: ride the open standard so supported-framework coverage grows with the ecosystem instead of with our integration backlog. The honest catch — and the most interesting part of the build — is that the GenAI conventions are still stabilizing in 2026, so "ride the standard" required a real normalization layer to absorb how each framework currently *diverges* from it. That layer is the heart of the repo, and `docs/FINDINGS.md` is the empirical evidence behind every line of it.

---

## Architecture

```
   Host agent process                                  Agnost (server-side)
 ┌─────────────────────────────────────────┐         ┌──────────────────────┐
 │  Vercel AI SDK / Mastra / OpenAI         │         │  conversation         │
 │        │ emits OTel GenAI spans          │         │  stitching, topic     │
 │        ▼                                 │         │  clustering, intent,  │
 │  ┌───────────── @agnost/sdk ──────────┐  │  OTLP   │  sentiment, evals,    │
 │  │ instrument()                       │  │  /HTTP  │  dashboards           │
 │  │  ├─ tag    identity (agnost.*)     │──┼────────▶│                      │
 │  │  ├─ redact content gate (opt-in)   │  │  raw    │  (raw spans = the     │
 │  │  └─ ship   BatchSpanProcessor      │  │  spans  │   ground-truth asset) │
 │  │            + never-throw exporter  │  │         └──────────────────────┘
 │  └────────────────────────────────────┘  │
 └─────────────────────────────────────────┘
   The client does four things only:
   observe · tag · (optionally) redact · ship.
```

The client is intentionally dumb. `instrument()` registers a `NodeTracerProvider`, wraps a `BatchSpanProcessor` so export is off the host's request path, stamps `agnost.*` identity on span start, applies the content policy on span end, and exports via a retrying OTLP/HTTP wrapper that **swallows every failure**. The mapper that projects spans into a friendly `CanonicalEvent` is used for tests and demo readability — it is *not* in the ingest path; what ships to Agnost is the raw spans, losslessly.

---

## Decisions and rejected alternatives

| Decision | Chosen | Rejected — and why |
|---|---|---|
| What the SDK *is* | Thin OTel pipe over frameworks' built-in telemetry | **Hand-rolled per-framework wrappers** — re-solves what frameworks already do, more code, less robust, a maintenance treadmill as frameworks multiply |
| Transport | Out-of-band OTLP/HTTP via batch processor | **Proxy / drop-in `baseURL`** — puts Agnost in the model-request hot path, so the customer's agent availability now depends on *our* uptime. Unacceptable risk for an observability vendor |
| Where interpretation lives | Server-side; client ships raw | **Client-side normalization** — client logic is frozen at the installed version (server fixes ship instantly; client fixes need every customer to upgrade), runs in the hot path, and would discard the raw signal that *is* Agnost's product |
| Normalization shape | One mapper, three data tables | **Per-framework mapper branches** — collapses the moment divergence appears; tables let the *code* stay constant while only the data shrinks as OTel matures |
| Language | TypeScript / Node | **Python** — all three targets are TS-first (Mastra is TS-only); meet the ecosystem where it lives |

A note on intellectual honesty rather than marketing: the OTel **GenAI conventions are experimental, not stable**. We bet on the *direction*, not on today's coverage. The normalization tables are the bridge across that gap, and they are designed to shrink to nothing as the standard wins.

---

## The thin-client / server-side seam (the load-bearing choice)

Complexity belongs where change is cheap. Three properties of *client* code make it the wrong place for anything that might evolve: it runs in the customer's hot path (risk), it is frozen at whatever version they installed (slow to fix), and it multiplies across every framework and language (N implementations to keep in sync). Server-side, all three reverse — one implementation, instant iteration, zero host risk.

There's a second reason specific to *this* company: **the raw data is the moat.** Agnost's value is finding intent signals nobody knew were in their conversations. Normalizing-and-discarding on the client throws away signal before it reaches the place that monetizes it, and bakes today's idea of "what matters" into a frozen client. So every `CanonicalEvent` carries `raw_otel_attrs` — a lossless copy — and the client never derives signal away.

**The one deliberate exception:** content redaction *must* be client-side, because you cannot redact data server-side that you've already received. So `captureContent` defaults to **off** (content-bearing attributes and events are stripped before the exporter sees them), and when on, an optional redactor runs **before** export. The default redactor catches structured PII (emails, phone-shaped strings, common key prefixes) and is intentionally narrow — it's a sensible default plus a pluggable hook, *not* a claim of complete PII protection. The architectural point is that the hook sits at the right seam.

*Anticipated objection — "raw OTLP is expensive in bandwidth/storage."* True, and the right answer at their stage is **sampling/compression**, not lossy client-normalization. A startup hunting for product insight should preserve signal first and optimize cost when it actually bites — and do it without throwing away the asset.

---

## What the build actually found (and why it's the interesting part)

The thesis "all three speak OTel" turned out to be true but uneven — they speak *dialects*. This is the empirical core, captured as **real spans** (no synthetic fixtures; the mapper test fails loudly if fixtures are missing) and documented in `docs/FINDINGS.md`:

- **OpenAI** (standards baseline): clean `gen_ai.*` attributes; content on span *events*; tool calls JSON-stringified (OTel attributes disallow nested objects). Divergences from canonical assumptions: none.
- **Vercel AI SDK**: the framework that motivated the alias table. A single `generateText` call emits **three spans** — an outer `ai.generateText` *wrapper*, an inner `ai.generateText.doGenerate` *inference* span, and `ai.toolCall`. Mapping both generate spans to `chat` would **double-count turns and tokens** — so the wrapper maps to `invoke_agent` (trace linkage, no turns), only the inner span produces turns. Vercel also omits `gen_ai.operation.name` (we fall back to span-name patterns), puts content on JSON attributes instead of events (`ai.prompt.messages`), and reports the provider as `"openai.responses"` — a framework-internal namespace we normalize back to `"openai"`.
- **Mastra**: OTel lives in a *separate* `@mastra/otel-bridge` package, not in core — looking at core alone wrongly suggests Mastra has no OTel. Once bridged, a single `agent.generate` produced **27 spans** — `invoke_agent`, `chat`, five `execute_tool`, and internal lifecycle markers that correctly fall to `other`. This is the **agent seam** the SDK most wants: intent lives in the agent loop, not just the raw completion. Mastra spells provider as `gen_ai.provider.name` and uses a `parts[].content` message shape vs Vercel's `content[].text` — one flatten helper accepts both.

All of this is absorbed by **three data tables** in a single mapper — `OPERATION_NAME_PATTERNS`, `ATTRIBUTE_ALIASES`, and a provider-normalization set. The consuming code is identical no matter which framework emitted the span; divergence is *data*, not branches. As each framework adopts the standard, table entries are deleted and the code is untouched. That is the testable form of "thin client riding the open standard."

---

## Onboarding: the funnel is the product

Integration friction is adoption lost. `npx agnost-init` detects the framework from `package.json` and prints exactly what to add — the two-minute path made literal. The repo also ships a mock OTLP ingest server + viewer so the whole loop is runnable end-to-end with **zero API keys** (capture uses real provider calls for fixtures, but the demo path does not require them).

The vision this points at: the observability layer that wins won't be the one with the *most* integrations — it'll be the one that needs the *fewest*, because everything speaks OTel and onboarding collapses to "you already emit the spans; point them at us." Distribution then rides the standard — framework-native plugins, templates so new agents are born instrumented, and an MCP server so an agent can query *its own* analytics.

---

## What I'd do with a month instead of a weekend

- **Server-side processing pipeline** — the actual conversation stitching (spans → coherent multi-turn threads across the agent loop), topic clustering, intent extraction, sentiment, and evals. This is where the raw-signal bet pays off, and it's deliberately *not* in the weekend client.
- **`agnost-init` as a codemod** — not just print the snippet, but AST-rewrite it in safely.
- **Sampling + cost controls** — head/tail sampling, compression, per-project budgets — the principled answer to the bandwidth objection.
- **Coverage by riding the standard** — LangGraph, CrewAI, Agno, and others come almost for free as they emit OTel; each new framework should be table entries (or zero), not a new pipeline.
- **A real redaction policy engine** — pluggable, with structured-PII and LLM-based options, replacing the deliberately-narrow default.
- **A Python SDK** — same thin-pipe design, for the non-TS half of the ecosystem.
- **Filter bridge-shutdown warning noise** (`[OtelBridge] No OTEL span found…`) so it never reaches customer logs.

---

## Honest status of this submission

What works, verified: typecheck clean; **38/38 tests pass** across mapper (against three real fixtures), transport (retry/backoff), redaction, and degradation (host survives an unreachable Agnost). All three profiles, the init CLI, and the mock ingest are implemented.

Known issue to fix before any real publish: a clean `npm install` hits a peer-dependency conflict (`openai@4` wants `zod@^3`; the project pins `zod@^4`) — it installs with `--legacy-peer-deps`, but the right fix is to align the `zod` range or move the `openai` dep. Flagging it rather than hiding it, because "did you run it from clean" is exactly the kind of thing that should be surfaced, not papered over.
