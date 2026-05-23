// Assumed Agnost ingest schema. PRD §8 explicitly allows assuming the contract;
// this file documents what we assume so a real backend can either match it or
// the adapter is one file to change.
//
// The shape favors signal preservation over normalization. Friendly fields are
// best-effort projections of the GenAI semantic conventions; `raw_otel_attrs`
// is the lossless copy and is what server-side processing should treat as
// ground truth. Never drop signal here.

export type OperationKind =
  | "chat"
  | "invoke_agent"
  | "execute_tool"
  | "embeddings"
  | "other";

export interface Identity {
  project_id?: string;
  session_id: string;
  user_id?: string;
  framework: string;
  service_name: string;
}

export interface ToolCall {
  name: string;
  arguments?: string;
  result?: string;
}

export interface ConversationTurn {
  role: string;
  content?: string;
}

export interface CanonicalEvent {
  // Identifiers
  conversation_id: string;
  turn_id: string;

  // What kind of GenAI operation this span represents.
  operation: OperationKind;

  // Friendly projections of GenAI conventions. Any field may be undefined if
  // the span did not carry the corresponding signal — we do not invent data.
  model?: string;
  provider?: string;
  role?: string;
  content?: string;
  turns?: ConversationTurn[];

  // Token + latency telemetry.
  input_tokens?: number;
  output_tokens?: number;
  latency_ms: number;

  // Tool-related spans collapse into here. For execute_tool spans, this is the
  // single tool. For chat spans that invoked tools, callers may aggregate.
  tool_calls?: ToolCall[];

  // Identity stamped by instrument().
  framework: string;
  service_name: string;
  project_id?: string;
  session_id: string;
  user_id?: string;

  // Wallclock start of the span.
  ts: string;

  // Lossless copy of the OTel attribute bag. Source of truth for server-side
  // processing — never derive away signal client-side.
  raw_otel_attrs: Record<string, unknown>;
}

// Structural subset of an OTel ReadableSpan that the mapper actually reads.
// Defined locally so live spans and fixture JSON both satisfy it.
export interface ReadableSpanLike {
  name: string;
  kind?: number;
  attributes: Record<string, unknown>;
  events?: ReadableSpanEvent[];
  startTime: HrTime | [number, number] | string | number;
  endTime: HrTime | [number, number] | string | number;
  status?: { code: number; message?: string };
  spanContext?: () => { traceId: string; spanId: string };
  // Some serializations flatten spanContext to plain fields.
  traceId?: string;
  spanId?: string;
}

export interface ReadableSpanEvent {
  name: string;
  attributes?: Record<string, unknown>;
  time?: HrTime | [number, number] | string | number;
}

export type HrTime = [number, number];
