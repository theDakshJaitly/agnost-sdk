import { instrument } from "../src/profiles/mastra.js";
import { defaultRedactor } from "../src/core/redact.js";
import { buildWeatherAgent } from "./mastra-agent.js";

export interface MastraDemoRunner {
  ask: (label: string, prompt: string) => Promise<string | undefined>;
  setRedaction: (enabled: boolean) => void;
  shutdown: () => Promise<void>;
}

const SERVICE_NAME = "agnost-demo-mastra";
const DEFAULT_MODEL = "qwen/qwen3-32b";

export function createMastraDemoRunner(): MastraDemoRunner {
  let redactionOn = false;
  const closureRedactor = (text: string): string =>
    redactionOn ? defaultRedactor(text) : text;

  // instrument() must register the global tracer provider before
  // @mastra/otel-bridge is constructed in buildWeatherAgent().
  const handle = instrument({
    apiKey: "demo-key",
    endpoint: process.env["AGNOST_ENDPOINT"] ?? "http://127.0.0.1:4318",
    serviceName: SERVICE_NAME,
    captureContent: true,
    redact: closureRedactor,
  });

  const { agent, mastra } = buildWeatherAgent({
    model: process.env["AGNOST_CAPTURE_MODEL"] ?? DEFAULT_MODEL,
    serviceName: SERVICE_NAME,
  });
  void mastra;

  return {
    async ask(label, prompt) {
      process.stderr.write(`\x1b[2m[demo] ${label}: ${prompt}\x1b[0m\n`);
      try {
        // Keep the real agent loop bounded; provider/tool-loop failures
        // are useful trace signal, but the demo should not burn tokens.
        const result = await agent.generate(prompt, { maxSteps: 2 });
        return result.text ? closureRedactor(result.text) : undefined;
      } catch (err) {
        process.stderr.write(
          `\x1b[2m[demo] model error (continuing): ${
            err instanceof Error ? err.message : String(err)
          }\x1b[0m\n`,
        );
        return undefined;
      } finally {
        await handle.flush();
      }
    },
    setRedaction(enabled) {
      redactionOn = enabled;
    },
    shutdown() {
      return handle.shutdown();
    },
  };
}
