// Minimal OTLP/HTTP+JSON decoder. Converts the wire-format object that
// `@opentelemetry/exporter-trace-otlp-http` POSTs to our mock-ingest
// receiver into a `ReadableSpanLike` array the mapper can consume.
//
// The OTLP JSON shape is stable; we decode only the trace bits we need.
// Anything we don't recognize is preserved in the canonical event's
// `raw_otel_attrs` because we pass the flattened attribute bag through
// untouched.

import type { ReadableSpanLike, ReadableSpanEvent, HrTime } from "../src/core/schema.js";

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
};

type KeyValue = { key: string; value: AnyValue };

interface OtlpEvent {
  timeUnixNano?: string;
  name?: string;
  attributes?: KeyValue[];
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: KeyValue[];
  events?: OtlpEvent[];
  status?: { code?: number; message?: string };
}

interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource?: { attributes?: KeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpTracesPayload {
  resourceSpans?: OtlpResourceSpans[];
}

function valueOf(v: AnyValue | undefined): unknown {
  if (v == null) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(valueOf);
  if (v.kvlistValue) {
    const out: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values ?? []) out[kv.key] = valueOf(kv.value);
    return out;
  }
  return undefined;
}

function flattenAttrs(attrs: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attrs) return out;
  for (const { key, value } of attrs) {
    out[key] = valueOf(value);
  }
  return out;
}

function nanosToHrTime(nanosStr: string | undefined): HrTime {
  if (!nanosStr) return [0, 0];
  // BigInt for precision; the JSON wire format stringifies these.
  try {
    const n = BigInt(nanosStr);
    const sec = Number(n / 1_000_000_000n);
    const nsec = Number(n % 1_000_000_000n);
    return [sec, nsec];
  } catch {
    return [0, 0];
  }
}

export function decodeOtlpTraces(payload: OtlpTracesPayload): ReadableSpanLike[] {
  const out: ReadableSpanLike[] = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = flattenAttrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const events: ReadableSpanEvent[] = (s.events ?? []).map((e) => ({
          name: e.name ?? "",
          attributes: flattenAttrs(e.attributes),
          time: nanosToHrTime(e.timeUnixNano),
        }));
        out.push({
          name: s.name ?? "",
          kind: s.kind,
          attributes: { ...resourceAttrs, ...flattenAttrs(s.attributes) },
          events,
          startTime: nanosToHrTime(s.startTimeUnixNano),
          endTime: nanosToHrTime(s.endTimeUnixNano),
          status: s.status?.code !== undefined ? { code: s.status.code, message: s.status.message } : undefined,
          traceId: s.traceId ?? "",
          spanId: s.spanId ?? "",
        });
      }
    }
  }
  return out;
}
