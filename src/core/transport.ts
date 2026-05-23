import {
  OTLPTraceExporter,
} from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";

// Quiet local logger. Never throws into host. Prefixed so a user grepping
// production logs can isolate Agnost SDK noise from their own.
function log(level: "warn" | "info", msg: string, err?: unknown): void {
  try {
    const line = `[agnost] ${msg}`;
    if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(line, err ?? "");
    } else {
      // eslint-disable-next-line no-console
      console.info(line);
    }
  } catch {
    // Logging itself must never throw upward.
  }
}

export interface TransportOptions {
  apiKey: string;
  // OTLP/HTTP endpoint. We append `/v1/traces` ourselves if the user passes
  // a base URL without it, matching how the upstream exporter is configured.
  endpoint: string;
  // Retry parameters. Defaults chosen so transient failures recover quickly
  // without DOSing a struggling collector.
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  // Optional fetch override for tests.
  headers?: Record<string, string>;
}

const DEFAULTS = {
  maxRetries: 3,
  initialBackoffMs: 250,
  maxBackoffMs: 4_000,
};

function jitter(ms: number): number {
  return ms * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps the upstream OTLPTraceExporter with a never-throw shell + bounded
// retry on transient failure. The BatchSpanProcessor already pushes export
// off the host's hot path; this layer only guarantees that no exception
// from the exporter, the network, or the user's environment can bubble
// into the host agent. PRD §7 invariant.
export function createTransport(opts: TransportOptions): SpanExporter {
  const inner = new OTLPTraceExporter({
    url: opts.endpoint.endsWith("/v1/traces")
      ? opts.endpoint
      : `${opts.endpoint.replace(/\/+$/, "")}/v1/traces`,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      ...(opts.headers ?? {}),
    },
  });

  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const initialBackoff = opts.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULTS.maxBackoffMs;

  function attempt(
    spans: ReadableSpan[],
    cb: (result: ExportResult) => void,
    tries: number,
  ): void {
    try {
      inner.export(spans, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          cb(result);
          return;
        }
        if (tries >= maxRetries) {
          log(
            "warn",
            `export failed after ${tries + 1} attempts; dropping ${spans.length} span(s)`,
            result.error,
          );
          cb({ code: ExportResultCode.FAILED });
          return;
        }
        const delay = Math.min(maxBackoff, initialBackoff * 2 ** tries);
        sleep(jitter(delay))
          .then(() => attempt(spans, cb, tries + 1))
          .catch((e) => {
            log("warn", "retry scheduler error", e);
            cb({ code: ExportResultCode.FAILED });
          });
      });
    } catch (err) {
      // Synchronous throw from the inner exporter (rare but possible if
      // misconfigured). Swallow and return FAILED so the BatchSpanProcessor
      // continues normally.
      log("warn", "exporter threw synchronously", err);
      cb({ code: ExportResultCode.FAILED });
    }
  }

  return {
    export(spans, resultCallback) {
      try {
        attempt(spans, resultCallback, 0);
      } catch (err) {
        log("warn", "export shell error", err);
        try {
          resultCallback({ code: ExportResultCode.FAILED });
        } catch {
          // host's callback shouldn't throw, but if it does we swallow.
        }
      }
    },
    async shutdown() {
      try {
        await inner.shutdown();
      } catch (err) {
        log("warn", "shutdown error", err);
      }
    },
    async forceFlush() {
      try {
        if (typeof (inner as { forceFlush?: () => Promise<void> }).forceFlush === "function") {
          await (inner as { forceFlush: () => Promise<void> }).forceFlush();
        }
      } catch (err) {
        log("warn", "forceFlush error", err);
      }
    },
  };
}
