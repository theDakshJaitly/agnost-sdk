// Capture a real Vercel AI SDK run under an InMemorySpanExporter and dump
// the resulting spans to test/fixtures/vercel.spans.json.
//
// Same env contract as capture-openai.ts:
//   OPENAI_API_KEY                — required (any OpenAI-compatible key)
//   OPENAI_BASE_URL               — optional; defaults to OpenAI's endpoint
//   AGNOST_CAPTURE_MODEL          — optional; defaults to gpt-4o-mini
//   AGNOST_CAPTURE_PROVIDER       — optional; recorded for honesty
//
// The Vercel AI SDK emits its own GenAI-convention spans when
// experimental_telemetry is enabled and a tracer provider is registered.
// We let it do that, and capture exactly what it emits — no synthesis.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "vercel.spans.json",
);

if (!process.env["OPENAI_API_KEY"]) {
  console.error("[capture-vercel] OPENAI_API_KEY not set.");
  process.exit(1);
}

const MODEL = process.env["AGNOST_CAPTURE_MODEL"] ?? "gpt-4o-mini";
const PROVIDER_LABEL = process.env["AGNOST_CAPTURE_PROVIDER"] ?? "openai";

const memoryExporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
});
provider.register();

const llm = createOpenAI({
  apiKey: process.env["OPENAI_API_KEY"],
  baseURL: process.env["OPENAI_BASE_URL"],
});

async function run(): Promise<void> {
  await generateText({
    model: llm(MODEL),
    system: "You are a helpful weather assistant. Use the tool when asked.",
    prompt: "What's the weather in Paris today? My email is jane.doe@example.com.",
    tools: {
      get_weather: tool({
        description: "Get current weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temp_c: 17, sky: "cloudy" }),
      }),
    },
    stopWhen: stepCountIs(2),
    // The whole point of capturing through the SDK: telemetry on, content
    // recorded so the fixture has real prompts/responses.
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      metadata: { "agnost.capture.provider": PROVIDER_LABEL },
    },
  });

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
  }));

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(serialized, null, 2), "utf8");
  console.log(`[capture-vercel] wrote ${spans.length} span(s) to ${FIXTURE_PATH}`);

  await provider.shutdown();
}

run().catch((err) => {
  console.error("[capture-vercel] failed:", err);
  process.exit(1);
});
