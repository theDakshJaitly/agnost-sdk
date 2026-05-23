import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { instrument } from "../src/core/instrument.js";

// PRD §7 invariant: "Never crash or block the host agent. Transport
// failures, Agnost-down, malformed spans → swallow, log locally,
// degrade gracefully."
//
// This file is the contract test for that invariant. If anything here
// fails, the SDK is unsafe to embed in a customer's hot path.

let unhandled: { type: "exception" | "rejection"; err: unknown }[] = [];
let prevException: NodeJS.UncaughtExceptionListener[] = [];
let prevRejection: NodeJS.UnhandledRejectionListener[] = [];

const captureException: NodeJS.UncaughtExceptionListener = (err) => {
  unhandled.push({ type: "exception", err });
};
const captureRejection: NodeJS.UnhandledRejectionListener = (reason) => {
  unhandled.push({ type: "rejection", err: reason });
};

beforeEach(() => {
  unhandled = [];
  prevException = process.listeners("uncaughtException");
  prevRejection = process.listeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  process.on("uncaughtException", captureException);
  process.on("unhandledRejection", captureRejection);
});

afterEach(() => {
  process.removeListener("uncaughtException", captureException);
  process.removeListener("unhandledRejection", captureRejection);
  for (const l of prevException) process.on("uncaughtException", l);
  for (const l of prevRejection) process.on("unhandledRejection", l);
});

describe("degradation — host survives Agnost-down", () => {
  it("instrument() returns a handle even with a refused endpoint", () => {
    const handle = instrument({
      apiKey: "fake",
      serviceName: "deg-test",
      endpoint: "http://127.0.0.1:1",
    });
    expect(handle).toBeDefined();
    expect(typeof handle.shutdown).toBe("function");
  });

  it("creating spans against an unreachable endpoint does not throw", async () => {
    const handle = instrument({
      apiKey: "fake",
      serviceName: "deg-test",
      endpoint: "http://127.0.0.1:1",
    });
    const tracer = trace.getTracer("deg");
    expect(() => {
      const span = tracer.startSpan("chat deg-model", {
        attributes: {
          "gen_ai.system": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "deg-model",
        },
      });
      span.addEvent("gen_ai.user.message", { role: "user", content: "hi" });
      span.end();
    }).not.toThrow();
    await handle.shutdown();
  });

  it("shutdown() resolves cleanly even when export fails", async () => {
    const handle = instrument({
      apiKey: "fake",
      serviceName: "deg-test",
      endpoint: "http://127.0.0.1:1",
    });
    const tracer = trace.getTracer("deg");
    tracer.startSpan("chat x").end();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("emits no uncaught exceptions or unhandled rejections during full lifecycle", async () => {
    const handle = instrument({
      apiKey: "fake",
      serviceName: "deg-test",
      endpoint: "http://127.0.0.1:1",
    });
    const tracer = trace.getTracer("deg");
    for (let i = 0; i < 5; i++) {
      const span = tracer.startSpan(`chat n${i}`, {
        attributes: { "gen_ai.system": "openai", "gen_ai.operation.name": "chat" },
      });
      span.end();
    }
    await handle.shutdown();
    // Let any deferred rejections surface.
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  });

  it("instrument() is idempotent — second call returns existing handle", () => {
    const first = instrument({
      apiKey: "fake",
      serviceName: "deg-test",
      endpoint: "http://127.0.0.1:1",
    });
    const second = instrument({
      apiKey: "fake",
      serviceName: "different",
      endpoint: "http://127.0.0.1:1",
    });
    expect(second).toBe(first);
  });
});
