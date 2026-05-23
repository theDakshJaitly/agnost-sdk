export { instrument } from "./core/instrument.js";
export type { InstrumentOptions, InstrumentHandle } from "./core/instrument.js";

export { spanToCanonical } from "./core/mapper.js";
export type {
  CanonicalEvent,
  ConversationTurn,
  Identity,
  OperationKind,
  ReadableSpanLike,
  ReadableSpanEvent,
  ToolCall,
} from "./core/schema.js";

export { defaultRedactor } from "./core/redact.js";
export type { Redactor } from "./core/redact.js";
