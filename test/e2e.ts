// Manual end-to-end check. Run with:
//   npx tsx mock-ingest/server.ts &   # in one process
//   npx tsx test/e2e.ts                # in another
// then kill the server. Expects to see a canonical event on the
// server's stdout after this script completes.
import { trace } from "@opentelemetry/api";
import { instrument } from "../src/index.js";

const handle = instrument({
  apiKey: "fake-key",
  serviceName: "e2e-smoke",
  endpoint: "http://127.0.0.1:4318",
  captureContent: true,
  framework: "openai",
});

const tracer = trace.getTracer("e2e");
const span = tracer.startSpan("chat e2e-model", {
  attributes: {
    "gen_ai.system": "openai",
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "e2e-model",
    "gen_ai.usage.input_tokens": 10,
    "gen_ai.usage.output_tokens": 5,
  },
});
span.addEvent("gen_ai.user.message", { role: "user", content: "hi" });
span.addEvent("gen_ai.choice", { role: "assistant", content: "hello!", finish_reason: "stop" });
span.end();

await handle.shutdown();
console.log("e2e client done");
