import { OtelBridge } from "@mastra/otel-bridge";
import { instrument as baseInstrument, type InstrumentHandle, type InstrumentOptions } from "../core/instrument.js";

// Mastra profile.
//
// Mastra exposes an OTel bridge via the separate `@mastra/otel-bridge`
// package (not bundled into `@mastra/core`). Wiring is:
//
//   new Mastra({
//     observability: {
//       configs: {
//         default: { serviceName, bridge: new OtelBridge() }
//       }
//     }
//   })
//
// The bridge emits real OTel spans for every Mastra span (invoke_agent,
// execute_tool, the inner LLM call) and respects ambient AsyncLocalStorage
// context, so Mastra spans nest correctly under whatever tracer provider
// instrument() has registered.
//
// The profile does two things:
//   1. Re-exports instrument() with framework: "mastra" baked in.
//   2. Re-exports OtelBridge so users only install @agnost/sdk; the bridge
//      ships as a transitive runtime dep. As Mastra matures and folds OTel
//      into core, this re-export drops to a no-op and is removed.

export function instrument(opts: Omit<InstrumentOptions, "framework">): InstrumentHandle {
  return baseInstrument({ ...opts, framework: "mastra" });
}

export { OtelBridge };

// Convenience: build the `observability` config block in one call. The
// shape matches Mastra's expected structure so users can spread it.
export function mastraObservability(opts: { serviceName: string }): {
  configs: { default: { serviceName: string; bridge: OtelBridge } };
} {
  return {
    configs: {
      default: {
        serviceName: opts.serviceName,
        bridge: new OtelBridge(),
      },
    },
  };
}
