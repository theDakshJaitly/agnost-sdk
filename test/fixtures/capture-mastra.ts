// Capture real Mastra Agent spans via @mastra/otel-bridge and dump to
// test/fixtures/mastra.spans.json.
//
// Same env contract as the other capture scripts. The model adapter is
// @ai-sdk/openai so Groq's OpenAI-compatible endpoint works.
//
// Agent construction is shared with the live demo via
// `examples/mastra-agent.ts` — same agent, same tool, both contexts.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { buildWeatherAgent } from "../../examples/mastra-agent.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "mastra.spans.json",
);

if (!process.env["OPENAI_API_KEY"]) {
  console.error("[capture-mastra] OPENAI_API_KEY not set.");
  process.exit(1);
}

const MODEL = process.env["AGNOST_CAPTURE_MODEL"] ?? "qwen/qwen3-32b";

// Register our in-memory tracer provider BEFORE building the agent —
// the OtelBridge captures the global tracer at construction.
const memoryExporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
});
provider.register();

const { mastra, agent } = buildWeatherAgent({
  model: MODEL,
  serviceName: "agnost-capture-mastra",
});

async function run(): Promise<void> {
  void mastra; // side-effectful registration; keep TS happy.

  await agent.generate(
    "What's the weather in Paris today? My email is jane.doe@example.com.",
    { maxSteps: 2 },
  );

  await provider.forceFlush();
  const spans: ReadableSpan[] = memoryExporter.getFinishedSpans();

  const serialized = spans.map((s) => ({
    name: s.name,
    kind: s.kind,
    attributes: s.attributes,
    events: s.events.map((e) => ({
      name: e.name,
      attributes: e.attributes,
      time: e.time,
    })),
    startTime: s.startTime,
    endTime: s.endTime,
    status: s.status,
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: (s as unknown as { parentSpanContext?: { spanId?: string } })
      .parentSpanContext?.spanId,
  }));

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(serialized, null, 2), "utf8");
  console.log(`[capture-mastra] wrote ${spans.length} span(s) to ${FIXTURE_PATH}`);

  await provider.shutdown();
}

run().catch((err) => {
  console.error("[capture-mastra] failed:", err);
  process.exit(1);
});
