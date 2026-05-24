import { instrument as baseInstrument, type InstrumentHandle, type InstrumentOptions } from "../core/instrument.js";

// LangGraph profile.
//
// The verified path today is LangGraph + Microsoft's `langchain-azure-ai`
// AzureAIOpenTelemetryTracer, which emits standard OTel GenAI spans
// (`invoke_agent`, `chat`, `execute_tool`). This profile remains thin: it
// only stamps Agnost identity for JS/TS hosts that already emit those spans.
// Python LangGraph examples in this repo use the Azure tracer directly.

export function instrument(opts: Omit<InstrumentOptions, "framework">): InstrumentHandle {
  return baseInstrument({ ...opts, framework: "langgraph" });
}
