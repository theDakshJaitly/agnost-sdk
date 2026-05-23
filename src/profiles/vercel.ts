import { instrument as baseInstrument, type InstrumentHandle, type InstrumentOptions } from "../core/instrument.js";

// Vercel AI SDK profile.
//
// The Vercel AI SDK already emits OpenTelemetry GenAI spans natively when
// the caller (a) has a tracer provider registered and (b) passes
// `experimental_telemetry: { isEnabled: true }` to each generateText /
// streamText call. The profile does two things:
//
//   1. Re-exports instrument() with framework: "vercel" baked in, so the
//      identity tag is correct without the user thinking about it.
//   2. Provides a `telemetry()` helper that produces the experimental_telemetry
//      object the AI SDK expects, defaulting recordInputs/recordOutputs to
//      the captureContent setting passed at instrument-time.
//
// Why this surface, not auto-magic? The Vercel SDK requires the telemetry
// option per-call — there is no global toggle. A helper keeps it one
// import-and-spread, which is the minimum honest amount of code.

export function instrument(opts: Omit<InstrumentOptions, "framework">): InstrumentHandle {
  return baseInstrument({ ...opts, framework: "vercel" });
}

export interface VercelTelemetryOptions {
  // If undefined, defaults to false to match instrument()'s privacy posture.
  captureContent?: boolean;
  // Allows attaching call-specific metadata that the AI SDK forwards into
  // span attributes. Useful for stitching server-side later.
  metadata?: Record<string, string | number | boolean>;
}

export function telemetry(opts: VercelTelemetryOptions = {}): {
  isEnabled: true;
  recordInputs: boolean;
  recordOutputs: boolean;
  metadata?: Record<string, string | number | boolean>;
} {
  const record = opts.captureContent ?? false;
  return {
    isEnabled: true,
    recordInputs: record,
    recordOutputs: record,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}
