# Fixture findings — where the GenAI conventions diverge in practice

This file records concrete divergences observed while capturing real spans
from each target framework. It is the empirical evidence that the OpenAI
GenAI semantic conventions are still stabilizing in 2026 — and the
justification for the attribute-alias / operation-name pattern tables in
`src/core/mapper.ts`.

Every entry shrinks as a framework adopts standard conventions. The
mapper *code* does not change — only the tables shrink. That is what
"config-driven, not branched" means in this codebase.

For the generated, fixture-backed breakdown, see
[`DIVERGENCE.md`](../DIVERGENCE.md). It is produced by
`npm run divergence-report` from the real captured fixtures and the
actual `spanToCanonical` mapper.

Current headline numbers, in the build-story order:

- **0 unrecognized spans across all four frameworks** — nothing fell
  through unexpectedly.
- **Vercel:** 4 spans; 0 known-internal lifecycle, 0 unrecognized;
  required four attribute aliases, three operation-name patterns, three
  tool aliases, and provider namespace normalization.
- **Mastra:** 12 spans; 9 known-internal lifecycle spans
  (`model_chunk`, `model_inference`, `model_step`), 0 unrecognized;
  required the provider alias and tool-result alias.
- **OpenAI:** 3 spans; 0 known-internal lifecycle, 0 unrecognized; no
  aliases or operation-name fallbacks fired.
- **LangGraph:** 10 spans; 0 known-internal lifecycle, 0 unrecognized;
  no operation-name fallback, no provider normalization, only the
  provider alias plus the `gen_ai.tool.call.result` tool-result alias.

The difficulty metric is mapper/table change cost, not raw span count:
Vercel forced the generic tables into existence, Mastra added standard
content/provider/tool-result coverage, OpenAI is the baseline, and
LangGraph reused the machinery with near-zero new shape work.

---

## OpenAI SDK (captured via `test/fixtures/capture-openai.ts`)

The capture script emits spans manually following current GenAI
conventions, because the OpenAI SDK itself does not yet auto-emit OTel.
This is therefore the cleanest fixture and the closest to what a
hypothetical "fully standards-conformant" framework would look like.

- `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` — all present
  and standard.
- Content lives on **span events**: `gen_ai.system.message`,
  `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`,
  `gen_ai.choice`. The mapper reads turns from these events.
- Tool calls on the `gen_ai.choice` event are **JSON-stringified** — OTel
  attribute values disallow nested objects, so the conventions adopted
  stringified arrays. Mapper parses defensively.
- `execute_tool` is emitted as a separate span with `gen_ai.tool.name` /
  `gen_ai.tool.result` attributes and tool arguments inside a
  `gen_ai.tool.message` event.

Divergences from the canonical mapper assumptions: **none**.

## Vercel AI SDK (`@ai-sdk/openai`, ai v6) — captured via `capture-vercel.ts`

Multiple divergences. This is the framework that motivated the alias table.

### 1. Three-span hierarchy per call (correctness trap)

A single `generateText({ tools })` invocation produces:

| Span name                         | Role                                       |
| --------------------------------- | ------------------------------------------ |
| `ai.generateText`                 | **Outer wrapper / agent loop.** Aggregates tokens and prompt across all model calls in the loop. Has no per-turn content. |
| `ai.generateText.doGenerate`      | **Inner inference event.** Contains the actual prompt-messages + response. THIS is the chat span. |
| `ai.toolCall`                     | Tool execution, one per tool call.         |

The naive mapping would treat both `ai.generateText` and
`ai.generateText.doGenerate` as `chat` and emit two canonical events per
real model call — duplicate turns and double-counted tokens. The mapper
must distinguish them:

- `ai.generateText` → `operation: "invoke_agent"` (no turns, no inference signal)
- `ai.generateText.doGenerate` → `operation: "chat"` (turns + tokens)
- `ai.streamText` / `ai.streamText.doStream` → same rule
- `ai.toolCall` → `operation: "execute_tool"`

Turns are emitted **only** for `chat`-operation spans. `invoke_agent`
spans produce a canonical event for trace linkage but never contribute
turns or duplicate token counts.

### 2. `gen_ai.operation.name` is missing

Vercel does not emit `gen_ai.operation.name`. The mapper falls back to
**span-name pattern matching** (`OPERATION_NAME_PATTERNS` in mapper.ts).

### 3. Provider namespace lie

Both `gen_ai.system` and `ai.model.provider` carry Vercel's internal
namespace: `"openai.responses"`, not `"openai"`. A plain alias keeps the
wrong value. The mapper applies `NAMESPACE_NORMALIZE` (regex against
known Vercel-internal suffixes: `responses`, `chat`, `completion`,
`embeddings`) and resolves to the real provider prefix.

### 4. Content lives on attributes, not events

Vercel's `events` array is empty. The conversation is on:
- `ai.prompt.messages` — JSON-stringified array of `{role, content}`
- `ai.response.text` — assistant text response (absent when only a tool was called)
- `ai.response.toolCalls` — JSON-stringified tool calls

The mapper reads events first; when empty and operation is `chat`, falls
back to parsing `ai.prompt.messages`. Parse is wrapped in try/catch — a
malformed/truncated JSON must not crash the host; the canonical event is
still emitted with `raw_otel_attrs` preserved and `turns: undefined`.

The redaction seam (`applyRedactionToSpan`) covers `ai.prompt.*` /
`ai.response.*` / `ai.toolCall.args` / `ai.toolCall.result` so attribute-
sourced content goes through the same content-gate and redactor as
event-sourced content. No bypass.

### 5. Tool-call attribute shape

Vercel tool spans use `ai.toolCall.name`, `ai.toolCall.args`,
`ai.toolCall.result` instead of `gen_ai.tool.*`. Aliases in the table.

## Mastra (`@mastra/core@1.36`, OTel via `@mastra/otel-bridge@1.1`)

Mastra OTel emission is **not in `@mastra/core`** — it lives in a
separate `@mastra/otel-bridge` package, wired in via the `Observability`
class from `@mastra/observability`. Looking at core alone gives the
wrong impression that Mastra doesn't emit OTel. It does, but only when
the bridge is explicitly attached:

```ts
new Mastra({
  observability: new Observability({
    configs: {
      default: { serviceName: "...", bridge: new OtelBridge() }
    }
  })
})
```

### 1. Provider attribute is spelled differently

Mastra emits `gen_ai.provider.name` instead of the OpenAI-conventions
`gen_ai.system`. Same value (and same Vercel-internal lie — Mastra wraps
Vercel's AI SDK internally, so it inherits the `"openai.responses"`
namespace value). Aliased + normalized by the same code path.

### 2. Content lives on attributes, JSON-encoded, with `parts[].content` shape

`gen_ai.input.messages` and `gen_ai.output.messages` carry JSON arrays
of `{ role, parts: [{ type: "text", content: "..." }] }`. Different from
Vercel's `{ role, content: [{ type, text }] }` — same idea, different
field names. The flatten helper accepts either `text` OR `content` on
text-typed parts, so one parser handles both.

### 3. Rich agent-loop span hierarchy (the agent-span showcase)

A single `agent.generate(...)` call produced 12 spans for the current
fixture: one `invoke_agent weather-agent`, one `chat <model>`, one
`execute_tool weatherTool`, and 9 Mastra-internal lifecycle markers
(`model_chunk`, `model_inference`, `model_step`). Only the first three
operation families carry canonical conversation signal; the lifecycle
markers correctly fall to `operation: "other"` and produce no turns.

This is exactly the agent seam the SDK wants to surface — intent at the
agent level, not just at the inference level. Mastra emits it cleanly.

### 4. Tool calls carry full namespace

`gen_ai.tool.call.arguments`, `gen_ai.tool.name`, `gen_ai.tool.result`
— closer to standard than Vercel's `ai.toolCall.*`, modulo the
`gen_ai.tool.call.arguments` path vs the standard
`gen_ai.tool.arguments`. One alias entry covers it.

### 5. Bridge-warning noise on shutdown

The bridge emits `[OtelBridge] No OTEL span found for Mastra span [id=...]`
warnings during capture for a handful of internal spans that close before
the bridge has registered them. The dumped fixture is unaffected (12
spans landed cleanly), but the noise is worth noting if it ever shows
up in customer logs. Not currently filtered.

## LangGraph (Python, OTel via `langchain-azure-ai`)

The verified path is specifically LangGraph with Microsoft's
`AzureAIOpenTelemetryTracer` callback from `langchain-azure-ai`, not
LangSmith's native OpenTelemetry export path. The tracer emits GenAI
semantic-convention spans that the existing mapper can read.

### 1. Standard operation names, no new mapper branch

The real fixture emitted 10 spans for one tool-using agent turn:
`invoke_agent` wrappers for LangGraph/LangChain runnable nodes, two
`chat` model calls, and one `execute_tool get_weather` span. Zero spans
fell to `operation: "other"`.

The happy-path loop is visible in the raw spans:

- first `chat` decides to call `get_weather`;
- `execute_tool get_weather` carries the call arguments and result;
- second `chat` receives the tool result and writes the final assistant
  answer into `gen_ai.output.messages`.

### 2. Provider/model/token fields are standard

LangGraph's Azure tracer emits `gen_ai.provider.name`,
`gen_ai.request.model`, `gen_ai.response.model`,
`gen_ai.usage.input_tokens`, and `gen_ai.usage.output_tokens`. The
existing attribute alias for `gen_ai.provider.name` covers provider
resolution. Against the Groq OpenAI-compatible endpoint, the provider
still reports `openai` because that is the SDK adapter namespace.

### 3. Turns use standard message attributes plus system instructions

Conversation messages are JSON-encoded on `gen_ai.input.messages` and
`gen_ai.output.messages` with the same `{ role, parts: [...] }` shape
Mastra already exposed. LangGraph also puts the prompt on
`gen_ai.system_instructions`, so the mapper now folds that standard
attribute into a normal `system` turn.

### 4. Tool result alias

The tool span uses `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result`. The arguments key was already covered; the
result key needed one table entry alongside `gen_ai.tool.result`.

Net result: LangGraph + Azure tracer required no framework-specific
mapper branch, only two generic GenAI table/parser extensions.

---

## Provider reflects SDK adapter namespace, not the resolved endpoint

A persistent observation across the Vercel and Mastra fixtures: when
calls are routed through the OpenAI SDK or `@ai-sdk/openai` against an
OpenAI-compatible endpoint that is *not* OpenAI itself (Groq, Together,
Anyscale, vLLM, ...), `gen_ai.system` / `gen_ai.provider.name` carry the
**SDK adapter's namespace** (`openai`, after namespace normalization),
not the real endpoint host (`groq.com`).

This is correct emission — the frameworks are honestly reporting which
SDK adapter spoke to the wire — but it is not the question a customer
usually wants answered ("which provider actually served this token?").
Resolving the *true* provider requires looking at the resolved `baseURL`
(or the response headers, or DNS) and mapping it to a canonical
provider name. That mapping is:

- **out of scope for the thin client** by design — capturing the
  `baseURL` per-call would mean instrumenting every framework's HTTP
  layer, multiplying the integration surface we're trying to avoid;
- **a server-side enrichment task** — Agnost server can inspect the
  raw OTel attributes the client preserves, cross-reference known
  endpoint hosts, and stamp a `provider.resolved` field on the
  canonical event.

The mapper records what the framework emitted. The canonical event
preserves the full raw attribute bag (`raw_otel_attrs`) so server-side
enrichment has everything it needs. Client-side workarounds — sniffing
the baseURL, hard-coding provider-by-API-key prefix, etc. — were
considered and rejected: each adds drift between the client we ship
today and the resolution logic we'd want to evolve server-side.

If a customer-facing surface needs the true provider before
server-side enrichment lands, they can pass it explicitly:
`instrument({ ..., framework: "mastra-on-groq" })`. That stamps an
identity dimension the canonical event already carries and which the
viewer / server can prioritize.

## How the tables defend "one mapper, config-driven"

`src/core/mapper.ts` contains three data tables:

1. `OPERATION_NAME_PATTERNS` — span-name → `OperationKind`, ordered
   most-specific first.
2. `ATTRIBUTE_ALIASES` — canonical-key → list of alias keys (read first match).
3. `NAMESPACE_NORMALIZE` — provider-value-fixup for framework-internal lies.

The **consuming code** is identical regardless of which framework
emitted the span. As frameworks adopt the standard conventions, entries
in these tables shrink toward zero and the code stays exactly the same.
This is the test of the "thin client riding the open standard" thesis.
