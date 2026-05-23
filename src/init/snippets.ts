import type { DetectedFramework } from "./detect.js";

// The exact paste-ready snippet per framework. Kept here so the CLI
// stays a printer and the canonical strings live in one place.

const COMMON_HEADER = `// Add this near the top of your entry file. Set AGNOST_API_KEY in env.`;

const SNIPPETS: Record<DetectedFramework, string> = {
  vercel: `${COMMON_HEADER}
import { instrument, telemetry } from "@agnost/sdk/vercel";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-app",
  captureContent: true,
});

// Then on every generateText / streamText call:
//   await generateText({
//     model: ...,
//     prompt: ...,
//     experimental_telemetry: telemetry({ captureContent: true }),
//   });
`,

  mastra: `${COMMON_HEADER}
import { instrument, OtelBridge } from "@agnost/sdk/mastra";
import { Observability } from "@mastra/observability";
import { Mastra } from "@mastra/core";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-app",
  captureContent: true,
});

export const mastra = new Mastra({
  agents: { /* ... */ },
  observability: new Observability({
    configs: {
      default: {
        serviceName: "my-app",
        bridge: new OtelBridge(),
      },
    },
  }),
});
`,

  openai: `${COMMON_HEADER}
import { instrument, wrapOpenAI } from "@agnost/sdk/openai";
import OpenAI from "openai";

instrument({
  apiKey: process.env.AGNOST_API_KEY!,
  serviceName: "my-app",
  captureContent: true,
});

// Wrap your client once; existing code keeps working unchanged.
export const openai = wrapOpenAI(new OpenAI());
`,
};

export function snippetFor(framework: DetectedFramework): string {
  return SNIPPETS[framework];
}
