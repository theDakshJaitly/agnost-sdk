# Agnost SDK — Build Spec / PRD

> **For:** Claude Code (implementation) + Daksh (review/ownership)
> **Project:** `agnost-sdk` — a TypeScript integration layer that gets any GenAI/agent pipeline into Agnost with near-zero friction.
> **Assignment context:** Agnost interview, Track B (Full-Stack / FDE). Deliverables are a working GitHub repo + a `REASONING.md`. The bar is *reasoning, taste, and judgment* — "simpler and easier is better." This PRD is the build plan; `REASONING.md` is written separately and is the primary graded artifact.

---

## 0. One-paragraph thesis (the spine of everything)

Every modern agent framework already emits OpenTelemetry. So Agnost's integration is **not** a data-capture library — it's a thin, reliable **OTel pipe** plus per-framework **enablement**, paired with a two-minute onboarding command. The client does exactly four things: **observe** OTel spans, **tag** them with identity, **optionally redact** content, and **ship** them raw to Agnost. All interpretation — conversation stitching, clustering, intent extraction, evals — happens **server-side**, where it can evolve without a customer redeploy and where the raw signal is preserved as Agnost's core asset.

The bet: ride the open standard (OpenTelemetry GenAI semantic conventions) so supported-framework coverage grows with the ecosystem instead of with our integration backlog.

---

## 1. Background & grounding facts

These are verified and must be respected by the implementation (they're also the backbone of `REASONING.md`):

- **OpenTelemetry (OTel)** is the CNCF vendor-neutral standard for telemetry. Core unit = a **span** (named, timed operation with key-value attributes); spans nest into **traces**. An **exporter** ships spans to a destination; a **batch processor** does this off the hot path (~<1% overhead, never inline with the user request).
- **GenAI semantic conventions** define standard span/attribute names for AI ops (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `invoke_agent`, `execute_tool`, etc.). **Status: experimental/Development, not yet stable** as of 2026. This is a *bet on direction*, stated honestly.
- **Content is suppressed by default** in the GenAI conventions (PII-protection design principle). Capturing prompt/response **content must be explicitly opted into.** Agnost *needs* content (you can't cluster intent from token counts), so the SDK opts in deliberately and owns redaction.
- **All three target frameworks already emit OTel:**
  - **Vercel AI SDK** — built-in OTel via `experimental_telemetry: { isEnabled: true }`; emits `gen_ai.*` + `ai.*` spans with prompt/response/tokens/tool calls; content controlled via `recordInputs`/`recordOutputs` (default on).
  - **Mastra** — native OTel via `OtelBridge` / OTel exporter, GenAI conventions, agent-level span names (`invoke_agent`, `execute_tool {tool_name}`). This is the **agent-span** seam.
  - **OpenAI SDK** — most mature OTel auto-instrumentation of the three (community instrumentation libraries). Raw **inference** seam.

**Design consequence:** capture is largely *solved by the frameworks*. The work is being a clean OTel **sink** + thin **enablement** + reliable **transport** + **onboarding**. Do *less* capture code, not more.

---

## 2. Two seams (capture both — this is a key differentiator)

1. **Inference seam** — the raw model call (`gen_ai.client.*` spans): model, tokens, latency, content. (OpenAI, Vercel.)
2. **Agent seam** — the agent loop (`invoke_agent`, `execute_tool`, multi-step spans): where *intent* actually lives. (Mastra, Vercel tool calls.)

A naive submission only instruments the inference seam. We capture both, because intent lives in the agent loop, not the raw completion.

---

## 3. Architecture decision (locked) — thin client, server-side brains

**The client is a thin, dumb, reliable pipe. It does only four things:**

1. **Observe** — receive OTel spans the frameworks already emit (register a tracer provider + batch span processor).
2. **Tag** — stamp identity it alone knows: `project_id`, `session_id`, `user_id`, `framework`, `service_name`.
3. **Redact (optional)** — run a content-redaction hook **before** export. *This is the one deliberate exception to "everything server-side" — you cannot redact server-side data you've already received.*
4. **Ship** — batch + retry + backoff, export **raw** to Agnost. **Must never throw into / block / crash the host agent.**

**Everything else is server-side** (and lives in the "month, not weekend" section of `REASONING.md`, NOT in the weekend repo): conversation stitching, clustering, intent extraction, sentiment, evals, dashboards.

**Why (for REASONING.md):** complexity belongs where change is cheap. Client logic runs in the customer's hot path, is *frozen at their installed version* (server fixes ship instantly; client fixes need every customer to upgrade), and multiplies across frameworks/languages. Server-side keeps it to one implementation, iterable without customer redeploy. **Also:** the raw data is the moat — normalizing/discarding on the client throws away signal before it reaches the place that monetizes it, and bakes today's idea of "what matters" into a frozen client. Keeping raw server-side aligns with Agnost's "find signals you didn't know were there" thesis.

**Pre-loaded rebuttal** (have ready, put in doc): "raw OTLP is expensive in bandwidth/storage." Answer: at their stage *signal preservation beats cost optimization*; add **sampling/compression** (not lossy client-normalization) when cost actually bites.

**What we ship:** raw OTLP spans, identity-tagged, content opted-in + optionally redacted. We do **not** normalize-to-conversations on the client. (If a minimal canonical envelope is needed for the mock ingest demo, it wraps the raw span attributes losslessly — never replaces them.)

---

## 4. Rejected alternatives (must appear in REASONING.md)

| Decision | Chosen | Rejected | Why rejected |
|---|---|---|---|
| Capture strategy | Ride frameworks' built-in OTel + thin enablement | Hand-rolled wrappers per SDK | More code, less robust, re-solves what frameworks already solved; treadmill as frameworks multiply |
| Transport pattern | Out-of-band OTel batch export | **Proxy / drop-in `baseURL`** | Puts us in the customer's request hot path — latency + reliability + trust liability a startup must avoid |
| Long-term substrate | OpenTelemetry (open standard) | N bespoke per-framework integrations forever | Doesn't scale with the framework explosion; lock-in; maintenance treadmill |
| Where processing lives | Server-side | Client-side normalization | Frozen-at-version, hot-path risk, N implementations, discards raw signal/moat |
| Language | TypeScript / Node | Python | All three target SDKs are TS-first (Mastra is TS-only); meet the ecosystem where it is |

State the OTel caveat honestly: conventions are **experimental**. We bet on the *direction* and bridge today's gaps with thin enablement; as OTel matures, our enablement code thins toward zero.

---

## 5. Repo structure

```
agnost-sdk/
  package.json                 # workspaces / or single pkg w/ subpath exports
  tsconfig.json
  README.md                    # quickstart, the 2-min promise, demo gifs
  REASONING.md                 # SEPARATE deliverable — see §9 (not built by this PRD)
  src/
    core/
      instrument.ts            # instrument({ apiKey, serviceName, captureContent, redact })
      transport.ts             # OTLP batch exporter: retry, backoff, never-throw
      identity.ts              # project/session/user/framework tagging
      redact.ts                # content-safety hook (pluggable redactor)
      mapper.ts                # span(gen_ai.*) -> canonical event (LOSSLESS: keeps raw attrs)
      schema.ts                # canonical event type (assumed Agnost ingest schema, documented)
    profiles/
      vercel.ts                # enablement: experimental_telemetry on, recordInputs/Outputs
      mastra.ts                # enablement: OtelBridge wired to Agnost — AGENT-SPAN showcase
      openai.ts                # enablement: OTel auto-instrumentation for OpenAI client
    init/
      detect.ts                # read package.json, detect framework
      cli.ts                   # `npx @agnost/init` -> prints detected fw + exact snippet
  examples/
    vercel-agent/              # runnable: real generateText + a tool, emits spans
    mastra-agent/              # runnable: multi-step agent, invoke_agent/execute_tool spans
    openai-agent/              # runnable: chat.completions, inference spans
  mock-ingest/
    server.ts                  # local OTLP receiver (the fake Agnost backend)
    viewer.ts                  # terminal printer of normalized conversations
    tui.tsx                    # OPTIONAL Ink TUI: live conversations streaming in (END-CAP)
  test/
    mapper.test.ts             # **HIGH PRIORITY** feeds real spans from all 3 fw -> asserts identical canonical output
    transport.test.ts          # retry/backoff, never-throw on Agnost-down
    redact.test.ts             # content toggle + redaction actually removes PII
    degradation.test.ts        # Agnost down => host agent unaffected
```

---

## 6. Build priority (order matters — defensibility per surface)

> Guiding rule: **build as much as we can hold a real opinion about.** Breadth is fine (Claude Code is fast) but every surface must be defensible on a call. Nothing we'd have to shrug at when asked "why."

**P0 — load-bearing core (must be solid, not sketched):**
1. `schema.ts` — canonical event; document every field + that it's an *assumed* Agnost ingest schema.
2. `core/instrument.ts` + `transport.ts` — one-call setup, OTLP batch export, retry/backoff, **never throws into host**.
3. `core/identity.ts` — session/project/user/framework tagging.
4. `core/mapper.ts` — `gen_ai.*` span → canonical event, **lossless** (raw attrs preserved alongside).
5. `core/redact.ts` — opt-in content capture + pluggable redaction hook.
6. **`test/mapper.test.ts`** — the single most convincing artifact: capture real spans from all three frameworks, run through the one mapper, assert identical canonical shape. This *proves* "I normalized three frameworks into one schema." Prioritize this.

**P1 — the three profiles + runnable examples:**
7. `profiles/vercel.ts` + `examples/vercel-agent` (inference + tool spans).
8. `profiles/mastra.ts` + `examples/mastra-agent` (**agent-span showcase** — the part we specifically want).
9. `profiles/openai.ts` + `examples/openai-agent` (raw inference).
10. `test/transport.test.ts`, `test/redact.test.ts`, `test/degradation.test.ts`.

**P1 — onboarding showcase (the standout):**
11. `init/detect.ts` + `init/cli.ts` — `npx @agnost/init`: detect framework from package.json, **print what it detected + the exact snippet**. Lean by design. (Codemod = month, not weekend.)

**P1 — proof it works end-to-end:**
12. `mock-ingest/server.ts` + `viewer.ts` — local OTLP receiver + terminal printer. Run an example agent, watch conversations land. (Assume schema — assignment permits.)

**P2 — end-cap, cut without regret:**
13. `mock-ingest/tui.tsx` — Ink TUI, live conversations streaming as example agents run. Demos beautifully on the call. **Only if everything above is solid.**

---

## 7. Hard requirements / invariants

- **Never crash or block the host agent.** Transport failures, Agnost-down, malformed spans → swallow, log locally, degrade gracefully. There is a test for this.
- **Content capture is opt-in and visibly demonstrated** — the `recordInputs/recordOutputs`-style toggle must be wired end-to-end so the privacy story is *shown*, not just described. Redaction hook must actually remove PII in its test.
- **One mapper, not three.** The whole point is that GenAI conventions let a single normalizer handle all three. If you find yourself writing per-framework normalization branches, stop — that's the design failing.
- **Lossless.** Canonical event carries raw OTel attributes alongside the friendly fields. Never discard signal client-side.
- **TypeScript throughout.** Subpath exports (`@agnost/sdk`, `@agnost/sdk/vercel`, etc.) or a small workspace — keep it simple.
- **Two-minute promise is real.** README quickstart: install → one `instrument()` call (or `npx @agnost/init`) → run example → see conversation in mock ingest. Time it.

---

## 8. Assumptions to document (assignment allows assuming schema/API)

- **Agnost ingest endpoint:** assume an OTLP/HTTP endpoint (`POST /v1/traces`) + an Agnost API key in a header. Document the assumed contract.
- **Canonical event schema:** define and document (conversation_id, turn/role, content, model, provider, input_tokens, output_tokens, latency_ms, tool_calls[], framework, session_id, user_id, project_id, ts, + `raw_otel_attrs`).
- **Auth:** API key via env (`AGNOST_API_KEY`). No real backend needed — mock ingest stands in.

---

## 9. REASONING.md outline (separate deliverable — the primary graded artifact)

Keep to ~1–2 pages, diagrams + bullets + reasoning. Sections:

1. **Thesis** — §0 above, in one tight paragraph.
2. **The key insight** — frameworks already emit OTel; integration = pipe + enablement, not capture. Two seams (inference + agent).
3. **Architecture diagram** — host agent → framework OTel → Agnost SDK (observe/tag/redact/ship) → Agnost (server-side brains). One clear diagram.
4. **Decisions & rejected alternatives** — the §4 table, each with a *why*. Include the OTel-is-experimental honesty and the proxy rejection.
5. **Thin-client / server-side seam** — §3 reasoning: iteration velocity, blast radius, the data-is-the-moat point, the redaction exception. Include the cost rebuttal.
6. **The two-minute onboarding vision** — `init` today → codemod + framework auto-wiring tomorrow.
7. **Vision: future of agent onboarding & distribution** — standards convergence: the observability layer that wins needs the *fewest* integrations because everything speaks OTel; onboarding collapses to "you already emit the spans, point them at us"; distribution rides framework-native plugins + an MCP server so agents query their own analytics + templates so new agents are born instrumented.
8. **What I'd do with a month, not a weekend** — codemod `init`; sampling/cost controls; the server-side conversation-stitching + clustering + intent/eval pipeline; dashboards; MCP self-analytics server; framework-registry distribution; more language SDKs (Python).

---

## 10. Out of scope for the weekend repo (explicitly)

Conversation stitching, clustering, intent extraction, sentiment, evals, dashboards, codemod AST rewriting, sampling/cost controls, MCP server, Python SDK. **All of these go in REASONING.md §9.8 ("month, not weekend").** Showing restraint in the repo and ambition in the doc is the judgment being tested.

---

## 11. Definition of done (weekend)

- [ ] `instrument()` one-call setup works; OTLP batch transport with retry/backoff that never throws into host.
- [ ] One lossless `gen_ai.*` → canonical mapper, with a passing test proving identical output across all three frameworks.
- [ ] All three profiles each demoed by a runnable example agent producing real spans (Mastra shows agent spans).
- [ ] Opt-in content capture + redaction hook, wired end-to-end and tested.
- [ ] Graceful degradation test (Agnost down → host unaffected).
- [ ] `npx @agnost/init` detects framework + prints snippet.
- [ ] Mock ingest receiver + terminal viewer; end-to-end demo runs.
- [ ] README with the timed 2-minute quickstart.
- [ ] (Optional) Ink TUI live view.
- [ ] REASONING.md complete (separate, primary).
