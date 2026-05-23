# Build spec — live Mastra demo (`demo:mastra`)

> **For:** Claude Code, working in the `agnost-sdk` repo.
> **Goal:** Replace the "facade" e2e (which hand-builds a single span) with a **real Mastra agent** whose genuine OTel spans flow through the actual `instrument()` pipe into the live mock-ingest server and render in the viewer. This proves the whole loop works against a real agent loop, at both the inference seam and the agent seam.
> **Hard rule:** Build the **fixed/scripted** version first and make it solid + committed. Interactive mode is a *follow-up* (see §6) — do not start it until fixed works end to end.

---

## 0. Context you need (already in the repo — read before writing)

- `test/fixtures/capture-mastra.ts` — builds a real Mastra `weather-agent` with a `get_weather` tool, runs it against Groq via `@ai-sdk/openai`, and dumps spans to a JSON fixture using an **in-memory** exporter. **The demo is ~90% this file**, with the in-memory exporter swapped for the real pipe. Reuse its agent/tool setup; do not reinvent it.
- `src/profiles/mastra.ts` — exports `instrument()` (framework baked to `"mastra"`), `OtelBridge`, and `mastraObservability({ serviceName })`. Use these.
- `src/core/instrument.ts` — `instrument(opts)` returns a handle with `.shutdown()`. Options include `apiKey`, `endpoint` (defaults to Agnost; for the demo pass `http://127.0.0.1:4318`), `serviceName`, `captureContent`, `redact`, identity fields. It registers a `NodeTracerProvider` + `BatchSpanProcessor`. It is idempotent.
- `mock-ingest/server.ts` — OTLP/HTTP receiver on port `4318` (`POST /v1/traces`), maps spans via `spanToCanonical`, writes NDJSON to stdout. `mock-ingest/viewer.ts` — reads that NDJSON from stdin, pretty-prints grouped conversations with ANSI color. Run together: `npm run ingest | npm run view`.
- `.env` — already has a working Groq setup: `OPENAI_API_KEY` (Groq key), `OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `AGNOST_CAPTURE_MODEL` (e.g. `llama-3.3-70b-versatile`). The demo must use the **same env contract** — do not hardcode keys or model names.

---

## 1. What to build (fixed version)

Create `examples/mastra-live.ts` and a `demo:mastra` script in `package.json`.

The script must:

1. **Reuse the Mastra agent + tool setup** from `capture-mastra.ts` (weather-agent, `get_weather` tool, Groq via `@ai-sdk/openai`). Factor the shared agent-building into a small helper if clean, or copy it — either is fine, but the agent must be the real thing, not a stub.
2. **Wire the real pipe instead of the in-memory exporter.** Call `instrument()` from `src/profiles/mastra.ts` with:
   - `endpoint: process.env.AGNOST_ENDPOINT ?? "http://127.0.0.1:4318"`
   - `apiKey: "demo-key"` (mock server doesn't validate)
   - `serviceName: "agnost-demo-mastra"`
   - `captureContent` — see §3 (the two-beat redaction reveal)
   - identity: set a `session_id` per question so conversations group correctly in the viewer
3. **Attach the OtelBridge to Mastra** via `mastraObservability({ serviceName })` so Mastra emits real spans. **Verify the bridge spans actually nest under the tracer provider `instrument()` registered** — the profile claims ambient AsyncLocalStorage context handles this, but a live run is the real test. If spans don't reach the pipe, fix registration order (instrument() must register its provider before Mastra/OtelBridge initializes).
4. **Fire a fixed sequence of 2–3 questions** at the agent, in series, so multiple conversations stack in the viewer. At least one MUST trigger the tool (so `execute_tool` spans show). At least one MUST contain a piece of PII (keep the planted email pattern, e.g. "my email is jane.doe@example.com") for the redaction beat. Suggested set:
   - "What's the weather in Paris today?"  (tool, clean)
   - "Email me the forecast for Tokyo at jane.doe@example.com"  (tool + PII)
   - "Thanks — is it warmer than London?"  (follow-up, may or may not call tool)
5. **Flush before exit.** The `BatchSpanProcessor` batches off the hot path, so the process must `await handle.shutdown()` (or forceFlush) after the last question, or spans never export and the viewer shows nothing. This is the #1 way this demo silently "does nothing" — get it right.

---

## 2. The expected result (what success looks like)

With `npm run ingest | npm run view` in one terminal and `npm run demo:mastra` in another, the viewer should render real grouped agent loops — roughly:

```
┌ invoke_agent   conv=<id>   mastra · <model> · groq · <ms>
↳ chat           conv=<id>   mastra · <model> · groq · <ms> · in:<n> out:<n>
    user       What's the weather in Paris today?
    assistant  [tool call] get_weather
↳ execute_tool   conv=<id>   mastra · <ms>
    tool→      get_weather({"city":"Paris"})
    result     {"city":"Paris","temp_c":17,"sky":"cloudy"}
↳ chat           conv=<id>   mastra · <model> · groq · <ms> · in:<n> out:<n>
    assistant  It's 17°C and cloudy in Paris.
```

Real model, real tokens, real latency, both seams visible (`invoke_agent` + `chat` + `execute_tool`), grouped under one conversation. This is the artifact.

---

## 3. Redaction — the two-beat reveal (default behavior of the demo)

The demo should make the privacy story **visible**, not silent. Run the sequence in two passes:

- **Pass 1 — content visible:** `captureContent: true`, no redactor (or redactor off). The full conversation renders legibly. This proves "it works" and is the impressive view.
- **Pass 2 — redaction on:** `captureContent: true` **with the default redactor active**. Re-fire the question(s) containing PII. In the viewer, the email must now appear scrubbed (e.g. `[redacted-email]` or whatever the existing `src/core/redact.ts` default emits — use the real output, don't invent a format).

Print a clear divider line between passes (plain text, e.g. `─── pass 2: redaction on ───`) so it's obvious in the terminal which is which.

Also: the script should make clear (a comment + a one-line stdout note) that **`captureContent` defaults to OFF in real usage** — content capture is opt-in, and even when on, PII passes through the redaction seam before export. The demo turns it on explicitly to show data flowing.

Do **not** add ASCII art or a logo. A single dim header line (e.g. `agnost · live ingest`) is the maximum flourish. Keep it tasteful — the substance is the agent loop, not decoration.

---

## 4. README + reproducibility

- Add a **"Live demo"** section to `README.md` documenting the exact commands (the two-terminal `ingest | view` + `demo:mastra`), the env vars needed (point to `.env.example`), and a one-line note that the scary stderr from the degradation test is unrelated/expected elsewhere.
- The demo must run with **zero paid keys** — Groq free tier only. Never require an OpenAI key.
- If the agent setup is factored into a shared helper, make sure `capture-mastra.ts` still works (don't break fixture capture).

---

## 5. Guardrails / things that will bite

- **Flush/shutdown before exit** — see §1.5. Most likely failure mode.
- **Bridge span nesting** — see §1.3. Second most likely. Verify spans actually arrive; if the viewer is empty but no errors, this is why.
- **Never crash the demo on transport failure** — the whole point of the SDK is the host survives Agnost being down. If the mock server isn't running, the demo agent should still complete its model calls and exit cleanly (spans just get dropped with a quiet log). Do not let a dead endpoint throw.
- **Port 4318** must be free; the mock server and the demo both assume it.
- **Keep model/provider honest** — whatever Groq actually returns is what shows. Don't relabel the provider.
- Don't touch the existing passing tests or the mapper. This is additive.

---

## 6. Interactive mode (FOLLOW-UP ONLY — after fixed is committed)

Once the fixed demo works and is committed, add an interactive variant (e.g. `demo:mastra:repl` or a `--interactive` flag):

- A REPL: read a line from stdin, send it to the same agent, let spans flow to the viewer, loop.
- Same pipe, same instrument() setup — only the input source changes (stdin loop instead of a fixed array). Structure the fixed version so the agent-run-and-flush logic is a reusable function the REPL can call per line, so interactive is a thin wrapper, not a rewrite.
- Keep flush behavior correct per turn (forceFlush after each turn so the user sees output promptly, full shutdown on exit).
- This is the "go big" stretch. If it gets fiddly, the fixed demo is the fallback and is sufficient on its own.

---

## 7. Definition of done

**Fixed (must-have):**
- [ ] `npm run demo:mastra` runs a real Mastra agent against Groq, 2–3 questions in series.
- [ ] Real spans flow through `instrument()` → mock ingest → viewer; `invoke_agent`, `chat`, and `execute_tool` all visible, grouped by conversation, with real tokens/latency.
- [ ] Two-beat redaction reveal works: PII visible in pass 1, scrubbed in pass 2; "content capture is opt-in by default" stated.
- [ ] Flushes correctly (no empty viewer); survives a dead endpoint without throwing.
- [ ] README "Live demo" section; runs with Groq free key only.
- [ ] Existing tests + `capture-mastra.ts` still pass/work.

**Interactive (stretch, after commit):**
- [ ] REPL variant reusing the same pipe; thin wrapper over the fixed run logic.
