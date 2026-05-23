# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

This SDK package is a TypeScript-only "thin OpenTelemetry pipe" for shipping AI agent telemetry to Agnost. The authoritative spec is `PRD.md` — read it before making architectural changes. The assignment reasoning deliverable is not yet in this repo; the SDK itself is the supporting evidence.

`AGENTS.md` is a scaffold from a `.mex/` workflow (not yet filled in). The PRD overrides it where they disagree.

## Commands

- Build: `npm run build` (tsc output is configured in `tsconfig.json`)
- Typecheck only: `npm run typecheck`
- All tests: `npm test` (vitest include pattern is configured in `vitest.config.ts`)
- Watch tests: `npm run test:watch`
- Single test file: `npx vitest run test/mapper.test.ts`
- Single test by name: `npx vitest run -t "preserves raw OTel attributes"`
- Regenerate OpenAI/Groq fixture: `npm run capture:openai` (needs `.env` — copy `.env.example`)
- Regenerate Vercel AI SDK fixture: `npm run capture:vercel`

The `capture:*` scripts hit a **real** GenAI provider (OpenAI-compatible; default `.env.example` points at Groq) under an `InMemorySpanExporter` and write JSON to `test/fixtures/`. Synthetic fixtures are explicitly disallowed for the mapper test (see `test/mapper.test.ts`).

## Architecture — the four jobs

The client does only four things; everything else is server-side. Treat this as a hard constraint, not a guideline:

1. **Observe** — register a `NodeTracerProvider` + `BatchSpanProcessor`. Frameworks already emit OTel GenAI spans; we are the sink.
2. **Tag** — `src/core/identity.ts` stamps `agnost.*` attributes (`session_id`, `framework`, `service_name`, optional `project_id`/`user_id`) in `onStart`.
3. **Redact** — `src/core/redact.ts` runs in `onEnd` before export. Content (prompts/responses, `ai.*` prompt+response, `gen_ai.*.message` events, `gen_ai.choice`) is **stripped by default**; `captureContent: true` opts in, optionally through a `Redactor`.
4. **Ship** — `src/core/transport.ts` wraps `OTLPTraceExporter` with bounded retry/backoff and a never-throw shell.

Wiring lives in `src/core/instrument.ts`: it composes the identity stamp + redaction policy into a single `SpanProcessor` that delegates to a real `BatchSpanProcessor(transport)`. `instrument()` is idempotent in-process and returns an inert handle on setup failure — both deliberate.

### Mapping: one normalizer, never per-framework branches

`src/core/mapper.ts` (`spanToCanonical`) reads only OpenTelemetry GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.*.message` events, `gen_ai.choice`, `gen_ai.tool.*`). It produces `CanonicalEvent` from `src/core/schema.ts`. **If you find yourself adding `if (framework === "x")`, stop** — that's the design failing. The escape hatch is a config-driven attribute-alias table, not framework code. Span-name fallbacks (`invoke_agent`, `execute_tool ...`, `chat ...`) are conventions-fallbacks, not framework branches.

`CanonicalEvent.raw_otel_attrs` must remain a lossless copy of the source attribute bag. Never derive away signal client-side; the raw bag is ground truth for server-side processing.

### Profiles

`src/profiles/<framework>.ts` is **thin enablement only** — re-export `instrument()` with `framework: "<name>"` baked in, plus any per-framework toggle helper (e.g. Vercel's `telemetry()` returns the `experimental_telemetry` object the AI SDK expects per-call). No capture logic. Subpath exports in `package.json` (the package's Vercel, Mastra, and OpenAI profile exports) gate what's shipped.

### Hard invariants (PRD §7)

- **Never throw into host.** Every external callback (`onStart`, `onEnd`, exporter, shutdown) is wrapped in try/catch with a `[agnost]` log. New code at these seams must preserve this — `test/smoke.ts` currently tracks the planned degradation coverage.
- **Content capture is opt-in and visibly demonstrated.** Default `captureContent: false` strips content attrs and content-carrying events entirely (not placeholders). Redaction only runs when content is being captured.
- **Lossless canonicalization.** See above.

## Test fixture loop

`test/mapper.test.ts` is the proof artifact for the architecture: feed real captured spans from N frameworks through the one mapper, assert identical canonical shape (`structural equivalence across frameworks`). Adding a new framework should be a one-line append to the `FIXTURES` array once its `capture:*` script and `<fw>.spans.json` exist. The `beforeAll` loader throws a pointer-to-the-capture-script error when a fixture is missing — keep that behavior; it's the contract that prevents synthetic-fixture drift.

## Assumed contracts (documented because PRD §8 permits it)

- Agnost ingest = OTLP/HTTP at `${endpoint}/v1/traces`, `Authorization: Bearer ${apiKey}`. Default endpoint constant is in `src/core/instrument.ts`.
- `CanonicalEvent` (in `src/core/schema.ts`) is the assumed Agnost ingest schema. If the real schema differs, that file is the single point of change.

## Out of scope for this repo

Conversation stitching, clustering, intent extraction, evals, sampling/cost controls, codemod `init`, MCP server, Python SDK. These belong in the assignment writeup's "month, not weekend" section, not in code.
