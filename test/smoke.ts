// Manual never-throw smoke check (P0). Not part of npm test — the formal
// degradation.test.ts lands in P1 per the PRD priority. Run with:
//   npx tsx test/smoke.ts
import { trace } from "@opentelemetry/api";
import { instrument } from "../src/index.js";

const handle = instrument({
  apiKey: "fake-key",
  serviceName: "smoke-test",
  endpoint: "http://127.0.0.1:1/v1/traces",
  captureContent: true,
});

const tracer = trace.getTracer("smoke");
const span = tracer.startSpan("chat smoke-model", {
  attributes: {
    "gen_ai.system": "smoke",
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "smoke-model",
  },
});
span.addEvent("gen_ai.user.message", { role: "user", content: "hello" });
span.end();

await handle.shutdown();
console.log("OK: host process survived transport failure");
