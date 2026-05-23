// Mock Agnost ingest server. Listens for OTLP/HTTP traces and prints
// canonical events as newline-delimited JSON to stdout. Pipe into the
// viewer for a pretty-printed terminal feed:
//
//   npm run ingest | npm run view
//
// Or just use server output directly — the JSON is structured for
// downstream piping into jq, a log shipper, or whatever a real Agnost
// backend would do server-side.
//
// PRD §8 allows assuming the contract — we assume OTLP/HTTP+JSON on
// POST /v1/traces with a Bearer token in Authorization. The token is
// not validated (this is a dev fake).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spanToCanonical } from "../src/core/mapper.js";
import { decodeOtlpTraces, type OtlpTracesPayload } from "./otlp.js";

const PORT = Number(process.env["AGNOST_MOCK_INGEST_PORT"] ?? 4318);
const VERBOSE = process.env["AGNOST_MOCK_INGEST_VERBOSE"] === "1";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function handleTraces(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return readBody(req).then((raw) => {
    let payload: OtlpTracesPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      send(res, 400, { error: "invalid JSON" });
      return;
    }
    const spans = decodeOtlpTraces(payload);
    let emitted = 0;
    for (const s of spans) {
      try {
        const event = spanToCanonical(s);
        // NDJSON on stdout. One line per canonical event.
        process.stdout.write(JSON.stringify(event) + "\n");
        emitted += 1;
      } catch (e) {
        // The mapper is supposed to be defensive; if it ever throws,
        // log to stderr and keep going. Server must not crash.
        process.stderr.write(
          `[mock-ingest] mapper error on span ${s.name}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    send(res, 200, { partialSuccess: {} });
    if (VERBOSE) {
      process.stderr.write(`[mock-ingest] received ${spans.length} span(s), emitted ${emitted} event(s)\n`);
    }
  });
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/traces") {
    void handleTraces(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/healthz") {
    send(res, 200, { ok: true });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  process.stderr.write(
    `[mock-ingest] listening on http://127.0.0.1:${PORT}/v1/traces (NDJSON to stdout)\n`,
  );
});
