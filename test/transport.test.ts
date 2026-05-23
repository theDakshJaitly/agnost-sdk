import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import { createTransport } from "../src/core/transport.js";

// Boots a tiny HTTP server per test and asserts the never-throw shell
// retries on transient failure, drops cleanly when out of retries, and
// never lets an exception escape into the host.

let server: Server;
let port: number;
let requests: { status: number; bodySize: number }[] = [];
let responder: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

beforeEach(async () => {
  requests = [];
  responder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ partialSuccess: {} }));
  };
  server = createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      requests.push({ status: res.statusCode, bodySize: buf.length });
      responder(req, res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A minimal stub span satisfying the OTLP exporter's expectations. We
// pass it through the real exporter so the HTTP round-trip happens.
function stubSpan(): ReadableSpan {
  return {
    name: "chat test",
    kind: 0,
    spanContext: () => ({
      traceId: "0".repeat(32),
      spanId: "1".repeat(16),
      traceFlags: 1,
    }),
    parentSpanContext: undefined,
    startTime: [0, 0],
    endTime: [0, 1_000_000],
    status: { code: 0 },
    attributes: { "gen_ai.system": "test" },
    links: [],
    events: [],
    duration: [0, 1_000_000],
    ended: true,
    resource: { attributes: {}, asyncAttributesPending: false, waitForAsyncAttributes: async () => {}, merge: () => ({}) as never } as never,
    instrumentationScope: { name: "test", version: "0", schemaUrl: undefined } as never,
    instrumentationLibrary: { name: "test", version: "0", schemaUrl: undefined } as never,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

function exportOnce(transport: ReturnType<typeof createTransport>, spans: ReadableSpan[]): Promise<ExportResultCode> {
  return new Promise((resolve) => {
    transport.export(spans, (result) => resolve(result.code));
  });
}

describe("transport — never-throw shell", () => {
  it("forwards a successful 200 cleanly", async () => {
    const transport = createTransport({
      apiKey: "k",
      endpoint: `http://127.0.0.1:${port}`,
    });
    const code = await exportOnce(transport, [stubSpan()]);
    expect(code).toBe(ExportResultCode.SUCCESS);
    expect(requests.length).toBe(1);
    await transport.shutdown();
  });

  it("retries on 5xx then succeeds", async () => {
    let calls = 0;
    responder = (_req, res) => {
      calls += 1;
      if (calls < 2) {
        res.writeHead(503);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ partialSuccess: {} }));
      }
    };
    const transport = createTransport({
      apiKey: "k",
      endpoint: `http://127.0.0.1:${port}`,
      initialBackoffMs: 10,
    });
    const code = await exportOnce(transport, [stubSpan()]);
    expect(code).toBe(ExportResultCode.SUCCESS);
    expect(calls).toBe(2);
    await transport.shutdown();
  });

  it("gives up after maxRetries and reports FAILED without throwing", async () => {
    responder = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    const transport = createTransport({
      apiKey: "k",
      endpoint: `http://127.0.0.1:${port}`,
      maxRetries: 2,
      initialBackoffMs: 5,
    });
    const code = await exportOnce(transport, [stubSpan()]);
    expect(code).toBe(ExportResultCode.FAILED);
    expect(requests.length).toBe(3); // initial + 2 retries
    await transport.shutdown();
  });

  it("never throws when the endpoint is unreachable", async () => {
    // Port 1 is reserved; connection will be refused immediately.
    const transport = createTransport({
      apiKey: "k",
      endpoint: "http://127.0.0.1:1",
      maxRetries: 1,
      initialBackoffMs: 5,
    });
    await expect(exportOnce(transport, [stubSpan()])).resolves.toBe(ExportResultCode.FAILED);
    await transport.shutdown();
  });
});
