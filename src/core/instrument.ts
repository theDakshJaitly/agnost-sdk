import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  BatchSpanProcessor,
  type SpanProcessor,
  type Span,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { buildIdentity, identityToAttrs } from "./identity.js";
import { applyRedactionToSpan, type Redactor } from "./redact.js";
import { createTransport } from "./transport.js";

// Default Agnost ingest endpoint. PRD §8 explicitly permits assuming the
// contract; this constant is documentation of that assumption. A real
// deployment overrides it via opts.endpoint or the AGNOST_ENDPOINT env var.
const DEFAULT_ENDPOINT = "https://ingest.agnost.ai";

export interface InstrumentOptions {
  apiKey: string;
  serviceName: string;
  endpoint?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  framework?: string;
  // Privacy-first: content is dropped from spans before export unless this
  // is explicitly true. When true, the optional redactor below is applied.
  captureContent?: boolean;
  redact?: Redactor;
}

export interface InstrumentHandle {
  shutdown: () => Promise<void>;
  // Flush any batched spans to the exporter. Useful when the host wants
  // to ensure spans for the current logical turn arrive at the backend
  // before continuing — e.g. a per-question flush in a demo loop.
  flush: () => Promise<void>;
  // Exposed for tests / advanced users; do not rely on this surface.
  _provider: NodeTracerProvider;
}

let activeHandle: InstrumentHandle | undefined;

// Quiet local logger. Mirrors transport.ts. Never throws.
function log(msg: string, err?: unknown): void {
  try {
    console.warn(`[agnost] ${msg}`, err ?? "");
  } catch {
    /* logging must not throw */
  }
}

// SpanProcessor that stamps Agnost identity in onStart, applies the content
// policy in onEnd, then forwards to a real BatchSpanProcessor. Every callback
// is wrapped in try/catch — the PRD §7 invariant "never throws into host" is
// enforced at this seam, not just hoped for.
function makeAgnostProcessor(opts: InstrumentOptions, inner: SpanProcessor): SpanProcessor {
  const identity = buildIdentity({
    project_id: opts.projectId,
    session_id: opts.sessionId,
    user_id: opts.userId,
    framework: opts.framework,
    service_name: opts.serviceName,
  });
  const identityAttrs = identityToAttrs(identity);
  const captureContent = opts.captureContent ?? false;
  const redact = opts.redact;

  return {
    onStart(span: Span): void {
      try {
        // Respect any pre-existing identity attributes on the span.
        // Callers can override session_id (or any identity dimension)
        // per-call by injecting metadata via the framework's telemetry
        // hook (e.g. Mastra's tracingOptions.metadata, Vercel's
        // experimental_telemetry.metadata). The SDK fills in defaults
        // for keys the caller didn't set.
        const existing = (span as unknown as { attributes?: Record<string, unknown> }).attributes ?? {};
        for (const [k, v] of Object.entries(identityAttrs)) {
          if (existing[k] !== undefined) continue;
          span.setAttribute(k, v);
        }
      } catch (e) {
        log("onStart failed", e);
      }
    },
    onEnd(span: ReadableSpan): void {
      try {
        // ReadableSpan exposes attributes as a frozen-ish object on most
        // implementations, but the official SDK lets us mutate the same
        // underlying record in place. Treating it as writable here.
        applyRedactionToSpan(
          span as unknown as {
            attributes: Record<string, unknown>;
            events?: { name: string; attributes?: Record<string, unknown> }[];
          },
          { captureContent, redact },
        );
      } catch (e) {
        log("redaction failed", e);
      }
      try {
        inner.onEnd(span);
      } catch (e) {
        log("inner.onEnd failed", e);
      }
    },
    async shutdown(): Promise<void> {
      try {
        await inner.shutdown();
      } catch (e) {
        log("shutdown failed", e);
      }
    },
    async forceFlush(): Promise<void> {
      try {
        await inner.forceFlush();
      } catch (e) {
        log("forceFlush failed", e);
      }
    },
  };
}

export function instrument(opts: InstrumentOptions): InstrumentHandle {
  // Idempotent: a second call in the same process returns the existing
  // handle. Avoids the common footgun of double-registering tracers.
  if (activeHandle) {
    log("instrument() called twice; returning existing handle");
    return activeHandle;
  }

  try {
    const endpoint = opts.endpoint ?? process.env["AGNOST_ENDPOINT"] ?? DEFAULT_ENDPOINT;
    const exporter = createTransport({ apiKey: opts.apiKey, endpoint });
    const batch = new BatchSpanProcessor(exporter);
    const wrapped = makeAgnostProcessor(opts, batch);

    const provider = new NodeTracerProvider({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: opts.serviceName,
      }),
      spanProcessors: [wrapped],
    });
    provider.register();

    activeHandle = {
      _provider: provider,
      async flush(): Promise<void> {
        try {
          await provider.forceFlush();
        } catch (e) {
          log("provider.forceFlush failed", e);
        }
      },
      async shutdown(): Promise<void> {
        try {
          await provider.shutdown();
        } catch (e) {
          log("provider.shutdown failed", e);
        }
        activeHandle = undefined;
      },
    };
    return activeHandle;
  } catch (e) {
    // Catastrophic setup failure must still not crash the host. We return
    // an inert handle so callers can call shutdown() unconditionally.
    log("instrument() setup failed; returning inert handle", e);
    const inert: InstrumentHandle = {
      _provider: new NodeTracerProvider(),
      async flush(): Promise<void> {
        /* no-op */
      },
      async shutdown(): Promise<void> {
        /* no-op */
      },
    };
    activeHandle = inert;
    return inert;
  }
}
