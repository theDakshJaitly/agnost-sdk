// Shared factory for the demo Mastra agent. The fixture capture
// (`test/fixtures/capture-mastra.ts`) and the live demo
// (`examples/mastra-live.ts`) both call this so the agent stays the
// real thing in both contexts — same instructions, same tool, same
// model adapter.
//
// IMPORTANT: a global OTel tracer provider MUST be registered before
// calling this. The OtelBridge captures the global tracer eagerly at
// construction time (class field initializer), so registration order
// determines which provider receives Mastra's spans. The capture
// script registers its own BasicTracerProvider first; the live demo
// calls instrument() first. Either way, this factory must be the
// last thing called.

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { OtelBridge } from "@mastra/otel-bridge";
import { Observability } from "@mastra/observability";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

export interface BuildAgentOptions {
  // Model to pass to the OpenAI-compatible adapter (e.g. a Groq model id).
  model: string;
  // OpenAI-compatible API key; reads OPENAI_API_KEY from env if absent.
  apiKey?: string;
  // OpenAI-compatible base URL; reads OPENAI_BASE_URL from env if absent.
  baseUrl?: string;
  // Service name attached to the Mastra observability instance.
  serviceName: string;
}

export interface BuiltAgent {
  mastra: Mastra;
  agent: Agent;
}

export function buildWeatherAgent(opts: BuildAgentOptions): BuiltAgent {
  const llm = createOpenAI({
    apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"],
    baseURL: opts.baseUrl ?? process.env["OPENAI_BASE_URL"],
  });

  const weatherTool = createTool({
    id: "get_weather",
    description: "Get current weather for a city.",
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({
      city: z.string(),
      temp_c: z.number(),
      sky: z.string(),
    }),
    execute: async (ctx) => {
      // Mastra's createTool execute signature has shifted across minors;
      // the input is either passed directly or under `.context`. Tolerate both.
      const input = ctx as { city?: string; context?: { city?: string } };
      const city = input.city ?? input.context?.city ?? "unknown";
      return { city, temp_c: 17, sky: "cloudy" };
    },
  });

  const agent = new Agent({
    id: "weather-agent",
    name: "weather-agent",
    instructions:
      "You are a helpful weather assistant. Use the get_weather tool when " +
      "weather data would help. If a tool result is available, answer from " +
      "that result in one or two concise sentences.",
    model: llm(opts.model),
    tools: { weatherTool },
  });

  // Constructing OtelBridge here is the critical step — it captures
  // the currently-registered global tracer. See file header comment.
  const mastra = new Mastra({
    agents: { weatherAgent: agent },
    observability: new Observability({
      configs: {
        default: {
          serviceName: opts.serviceName,
          bridge: new OtelBridge(),
        },
      },
    }),
  });

  return { mastra, agent };
}
