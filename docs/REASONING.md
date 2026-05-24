# REASONING.md — Agnost SDK (Track B)

The integration question isn't "how do we capture agent conversations." The target frameworks mostly already capture them — Vercel AI SDK, Mastra, and LangGraph (via the Azure OTel tracer) emit OpenTelemetry; the OpenAI fixture is the explicit standards baseline because the OpenAI SDK does not yet auto-emit OTel. The real question is **how little we can ask a developer to do to get that data flowing into Agnost, without ever putting Agnost in a position to slow or break their agent.** So this SDK is deliberately a thin, reliable **OTel pipe**: observe the spans the framework already emits where available, tag them with identity, optionally redact content, ship them out of band. Everything that interprets the data — clustering, intent, evals — lives server-side, where it can change without a customer redeploy.

The bet underneath: ride the open standard so supported-framework coverage grows with the ecosystem instead of with our integration backlog. The honest catch — and the most interesting part of the build — is that the GenAI conventions are still stabilizing in 2026, so "ride the standard" required a real normalization layer to absorb how each framework currently *diverges* from it. That layer is the heart of the repo, and `docs/FINDINGS.md` is the empirical evidence behind every line of it.

---

## Architecture

![Agnost SDK thin client architecture](./architecture.svg)

The client is intentionally dumb. `instrument()` registers a `NodeTracerProvider`, wraps a `BatchSpanProcessor` so export is off the host's request path, stamps `agnost.*` identity on span start, applies the content policy on span end, and exports via a retrying OTLP/HTTP wrapper that **swallows every failure**. The mapper that projects spans into a friendly `CanonicalEvent` is used for tests and demo readability — it is *not* in the ingest path; what ships to Agnost is the raw spans, losslessly.

---

## Decisions and rejected alternatives

| Decision | Chosen | Rejected — and why |
|---|---|---|
| What the SDK *is* | Thin OTel pipe over frameworks' built-in telemetry | **Hand-rolled per-framework wrappers** — re-solves what frameworks already do, more code, less robust, a maintenance treadmill as frameworks multiply |
| Transport | Out-of-band OTLP/HTTP via batch processor | **Proxy / drop-in `baseURL`** — puts Agnost in the model-request hot path, so the customer's agent availability now depends on *our* uptime. Unacceptable risk for an observability vendor |
| Where interpretation lives | Server-side; client ships raw | **Client-side normalization** — client logic is frozen at the installed version (server fixes ship instantly; client fixes need every customer to upgrade), runs in the hot path, and would discard the raw signal that *is* Agnost's product |
| Normalization shape | One mapper, data tables | **Per-framework mapper branches** — collapses the moment divergence appears; tables let the *code* stay constant while only the data shrinks as OTel matures |
| Language | TypeScript / Node for the weekend SDK | **Building a production Python SDK this weekend** — OpenAI/Vercel/Mastra were the original TS-first targets; the LangGraph fixture proves the mapper thesis via Python OTel spans, while a production Python SDK remains month-scale work |

A note on intellectual honesty rather than marketing: the OTel **GenAI conventions are experimental, not stable**. We bet on the *direction*, not on today's coverage. The normalization tables are the bridge across that gap, and they are designed to shrink to nothing as the standard wins.

---

## The thin-client / server-side seam (the load-bearing choice)

Complexity belongs where change is cheap. Three properties of *client* code make it the wrong place for anything that might evolve: it runs in the customer's hot path (risk), it is frozen at whatever version they installed (slow to fix), and it multiplies across every framework and language (N implementations to keep in sync). Server-side, all three reverse — one implementation, instant iteration, zero host risk.

There's a second reason specific to *this* company: **the raw data is the moat.** Agnost's value is finding intent signals nobody knew were in their conversations. Normalizing-and-discarding on the client throws away signal before it reaches the place that monetizes it, and bakes today's idea of "what matters" into a frozen client. So every `CanonicalEvent` carries `raw_otel_attrs` — a lossless copy — and the client never derives signal away.

**The one deliberate exception:** content redaction *must* be client-side, because you cannot redact data server-side that you've already received. So `captureContent` defaults to **off** (content-bearing attributes and events are stripped before the exporter sees them), and when on, an optional redactor runs **before** export. The default redactor catches structured PII (emails, phone-shaped strings, common key prefixes) and is intentionally narrow — it's a sensible default plus a pluggable hook, *not* a claim of complete PII protection. The architectural point is that the hook sits at the right seam.

*Anticipated objection — "raw OTLP is expensive in bandwidth/storage."* True, and the right answer at their stage is **sampling/compression**, not lossy client-normalization. A startup hunting for product insight should preserve signal first and optimize cost when it actually bites — and do it without throwing away the asset.

---

## What the build actually found (and why it's the interesting part)

The thesis "frameworks speak OTel" turned out to be true but uneven — they speak *dialects*. This is the empirical core, captured as **real spans** (no synthetic fixtures; the mapper test fails loudly if fixtures are missing) and documented in `docs/FINDINGS.md`:

- **OpenAI** (standards baseline): the OpenAI SDK does not yet auto-emit OTel, so `capture-openai.ts` deliberately emits clean GenAI-convention spans as the baseline: `gen_ai.*` attributes, content on span *events*, and JSON-stringified tool calls (OTel attributes disallow nested objects). Divergences from canonical assumptions: none.
- **Vercel AI SDK**: the framework that motivated the alias table. The current full tool-loop fixture emits **four spans** — an outer `ai.generateText` *wrapper*, two inner `ai.generateText.doGenerate` *inference* spans (tool decision + final answer), and `ai.toolCall`. Mapping both wrapper and inference spans to `chat` would **double-count turns and tokens** — so the wrapper maps to `invoke_agent` (trace linkage, no turns), only the inner spans produce turns. Vercel also omits `gen_ai.operation.name` (we fall back to span-name patterns), puts content on JSON attributes instead of events (`ai.prompt.messages`), and reports provider namespace as the SDK adapter (`"openai.responses"`), not necessarily the resolved endpoint host. That adapter namespace propagates through Mastra too: a Groq-backed call can still report `"openai.responses"`. The mapper normalizes this to `"openai"` for readability, while true provider resolution is server-side enrichment and deliberately out of scope for the thin client.
- **Mastra**: OTel lives in a *separate* `@mastra/otel-bridge` package, not in core — looking at core alone wrongly suggests Mastra has no OTel. The current Qwen-backed fixture has **12 spans** — `invoke_agent`, one `chat`, one `execute_tool`, and nine known-internal lifecycle spans that correctly fall to `other`. An earlier Llama-on-Groq capture produced **27 spans** with five `execute_tool` spans and no final summary, which is exactly why the raw trace is useful: it distinguished model behavior from SDK behavior. Mastra spells provider as `gen_ai.provider.name` and uses a `parts[].content` message shape vs Vercel's `content[].text` — one flatten helper accepts both.
- **LangGraph**: the verified path is specifically Microsoft's `langchain-azure-ai` `AzureAIOpenTelemetryTracer`, not LangSmith's OpenLLMetry path. A real LangGraph tool-using run emitted **10 spans** — `invoke_agent` wrappers, two `chat` calls, and one `execute_tool`. Zero spans fell to `other`; the second chat carried the final assistant answer in `gen_ai.output.messages`. The only mapper extensions were generic GenAI support: fold `gen_ai.system_instructions` into a system turn and accept `gen_ai.tool.call.result` as a tool-result alias.

All of this is absorbed by **data tables and small generic parsers** in a single mapper — operation-name patterns, attribute aliases, provider normalization, tool-key aliases, and message-key handling. The consuming code is identical no matter which framework emitted the span; divergence is *data*, not branches. As each framework adopts the standard, table entries are deleted and the code is untouched. That is the testable form of "thin client riding the open standard."

---

## Onboarding: the funnel is the product

Integration friction is adoption lost. `npx agnost-init` detects the framework from `package.json` and prints exactly what to add — the two-minute path made literal.

The repo also includes live proofs, not just fixtures: `npm run demo:mastra` runs a real Mastra weather agent against a real Groq-hosted model, sends the genuine OTel spans through `instrument()` into the mock OTLP ingest server, and renders the resulting agent loop in the viewer. It shows both seams the SDK cares about — inference (`chat`) and agent behavior (`invoke_agent` / `execute_tool`) — with real latency and token counts. The demo also flips the redaction seam live: the first pass shows content with capture explicitly enabled, the second replays the PII prompt with the default redactor on so the email is scrubbed before export. `npm run demo:langgraph` proves the same viewer/mapper path against LangGraph's Azure tracer.

That live demo did something more useful than looking pretty: pointed at a real agent, it immediately surfaced a model-specific tool-calling failure. Llama-on-Groq repeatedly called the same tool and never summarized; switching to a more reliable Groq tool-calling model produced the expected one-tool-call + final-answer loop. That is the product premise in miniature — observability should expose broken agent loops, not hide them.

The vision this points at: the observability layer that wins won't be the one with the *most* integrations — it'll be the one that needs the *fewest*, because everything speaks OTel and onboarding collapses to "you already emit the spans; point them at us." Distribution then rides the standard — framework-native plugins, templates so new agents are born instrumented, and an MCP server so an agent can query *its own* analytics.

---

## What I'd do with a month instead of a weekend

- **Server-side processing pipeline** — the actual conversation stitching (spans → coherent multi-turn threads across the agent loop), topic clustering, intent extraction, sentiment, and evals. This is where the raw-signal bet pays off, and it's deliberately *not* in the weekend client.
- **`agnost-init` as a codemod** — not just print the snippet, but AST-rewrite it in safely.
- **Sampling + cost controls** — head/tail sampling, compression, per-project budgets — the principled answer to the bandwidth objection.
- **Coverage by riding the standard** — CrewAI, Agno, and others should come almost for free as they emit OTel; LangGraph was the proof case, needing table entries rather than a new pipeline.
- **A real redaction policy engine** — pluggable, with structured-PII and LLM-based options, replacing the deliberately-narrow default.
- **A Python SDK** — same thin-pipe design, for the non-TS half of the ecosystem; the LangGraph Python capture script is a proof fixture, not a production SDK.
- **Filter bridge-shutdown warning noise** (`[OtelBridge] No OTEL span found…`) so it never reaches customer logs.

---

## Honest status of this submission

What works, verified: typecheck clean; **44/44 tests pass** across mapper (against four real fixtures), transport (retry/backoff), redaction, and degradation (host survives an unreachable Agnost). All four profiles, the init CLI, the live Mastra demo/REPL, the live LangGraph demo, and the mock ingest/viewer are implemented.

A clean `npm install` completes without errors after deleting `node_modules` and `package-lock.json`. The remaining install output is ordinary engine/audit warning noise, not a dependency blocker.
