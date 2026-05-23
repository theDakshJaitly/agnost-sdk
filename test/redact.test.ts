import { describe, expect, it } from "vitest";
import { applyRedactionToSpan, defaultRedactor, type Redactor } from "../src/core/redact.js";
import type { ReadableSpanEvent } from "../src/core/schema.js";

// Privacy seam tests. Two layers:
//   1. The content-capture gate (captureContent boolean) strips
//      content attrs + events entirely when false. No bypass per
//      framework — `ai.prompt.messages`, `gen_ai.input.messages`,
//      `gen_ai.user.message` events all gone.
//   2. With captureContent=true, a user-supplied redactor function
//      runs over every content string before export.

function makeSpan() {
  const attrs: Record<string, unknown> = {
    "gen_ai.system": "openai",
    "gen_ai.request.model": "gpt-4o-mini",
    // Standard GenAI content attrs
    "gen_ai.prompt.0.content": "ssn 123-45-6789 jane.doe@example.com",
    // Vercel content attrs
    "ai.prompt.messages": '[{"role":"user","content":"hi jane.doe@example.com"}]',
    "ai.response.text": "hello! call 555-555-5555",
    "ai.toolCall.args": '{"city":"Paris"}',
    "ai.toolCall.result": '{"temp":17}',
    // Mastra content attrs
    "gen_ai.input.messages": '[{"role":"user","parts":[{"type":"text","content":"my email is x@y.com"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"sure"}]}]',
    "gen_ai.tool.call.arguments": '{"city":"Paris"}',
    "gen_ai.system_instructions": "be helpful; user email is jane.doe@example.com",
    "mastra.agent_run.input": "raw user prompt",
    "mastra.agent_run.output": "raw assistant output",
  };
  const events: ReadableSpanEvent[] = [
    {
      name: "gen_ai.user.message",
      attributes: { role: "user", content: "hi jane.doe@example.com" },
    },
    {
      name: "gen_ai.choice",
      attributes: {
        role: "assistant",
        content: "hello! sk-abcdefghijklmnop12345",
        finish_reason: "stop",
      },
    },
    {
      // Non-content event must survive.
      name: "exception",
      attributes: { type: "Error" },
    },
  ];
  return { attributes: attrs, events };
}

describe("redact — content capture gate", () => {
  it("strips ALL framework content attrs when captureContent=false", () => {
    const span = makeSpan();
    applyRedactionToSpan(span, { captureContent: false });
    // Gone:
    expect(span.attributes["gen_ai.prompt.0.content"]).toBeUndefined();
    expect(span.attributes["ai.prompt.messages"]).toBeUndefined();
    expect(span.attributes["ai.response.text"]).toBeUndefined();
    expect(span.attributes["ai.toolCall.args"]).toBeUndefined();
    expect(span.attributes["ai.toolCall.result"]).toBeUndefined();
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(span.attributes["gen_ai.output.messages"]).toBeUndefined();
    expect(span.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(span.attributes["gen_ai.system_instructions"]).toBeUndefined();
    expect(span.attributes["mastra.agent_run.input"]).toBeUndefined();
    expect(span.attributes["mastra.agent_run.output"]).toBeUndefined();
    // Kept:
    expect(span.attributes["gen_ai.system"]).toBe("openai");
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-4o-mini");
  });

  it("strips content events when captureContent=false but keeps non-content events", () => {
    const span = makeSpan();
    applyRedactionToSpan(span, { captureContent: false });
    const eventNames = (span.events ?? []).map((e) => e.name);
    expect(eventNames).not.toContain("gen_ai.user.message");
    expect(eventNames).not.toContain("gen_ai.choice");
    expect(eventNames).toContain("exception");
  });

  it("keeps content untouched when captureContent=true and no redactor", () => {
    const span = makeSpan();
    applyRedactionToSpan(span, { captureContent: true });
    expect(span.attributes["ai.response.text"]).toBe("hello! call 555-555-5555");
    expect((span.events ?? [])[1]?.attributes?.["content"]).toBe(
      "hello! sk-abcdefghijklmnop12345",
    );
  });
});

describe("redact — pluggable redactor hook", () => {
  it("applies user redactor to attribute strings", () => {
    const upper: Redactor = (t) => t.toUpperCase();
    const span = makeSpan();
    applyRedactionToSpan(span, { captureContent: true, redact: upper });
    expect(span.attributes["ai.response.text"]).toBe("HELLO! CALL 555-555-5555");
    expect(span.attributes["gen_ai.system_instructions"]).toMatch(/USER EMAIL/);
  });

  it("applies user redactor to event content fields", () => {
    const tag: Redactor = (t) => `[redacted:${t.length}]`;
    const span = makeSpan();
    applyRedactionToSpan(span, { captureContent: true, redact: tag });
    const userEvent = (span.events ?? []).find((e) => e.name === "gen_ai.user.message");
    expect(userEvent?.attributes?.["content"]).toMatch(/^\[redacted:\d+\]$/);
  });
});

describe("redact — defaultRedactor structured-PII catch", () => {
  it("redacts emails", () => {
    expect(defaultRedactor("contact jane.doe@example.com today")).toBe(
      "contact [redacted-email] today",
    );
  });
  it("redacts phone-shaped digits", () => {
    expect(defaultRedactor("ring me on +1 555-555-5555 please")).toMatch(
      /\[redacted-phone\]/,
    );
  });
  it("redacts OpenAI-style API keys", () => {
    expect(defaultRedactor("token=sk-ABCDEFG1234567890XYZ end")).toBe(
      "token=[redacted-key] end",
    );
  });
  it("passes ordinary text through unchanged", () => {
    expect(defaultRedactor("hello world")).toBe("hello world");
  });
  it("is a no-op on empty / non-string input", () => {
    expect(defaultRedactor("")).toBe("");
  });
});
