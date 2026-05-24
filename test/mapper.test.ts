import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { spanToCanonical } from "../src/core/mapper.js";
import type { CanonicalEvent, ReadableSpanLike } from "../src/core/schema.js";

// The mapper test is the proof artifact (PRD §6 #6). It MUST run against
// real captured OTel spans, not hand-written synthetic ones. Each fixture
// is produced by the corresponding capture script (e.g. capture-openai.ts)
// hitting a real GenAI provider under an InMemorySpanExporter and dumping
// the result.
//
// When new framework fixtures land, adding them is a one-line
// append to the FIXTURES array — the cross-fixture structural-equivalence
// test below proves the single mapper normalizes every framework
// identically.

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface FixtureCase {
  name: string;
  file: string;
  captureScript: string;
}

const FIXTURES: FixtureCase[] = [
  {
    name: "openai",
    file: "openai.spans.json",
    captureScript: "npm run capture:openai",
  },
  {
    name: "vercel",
    file: "vercel.spans.json",
    captureScript: "npm run capture:vercel",
  },
  {
    name: "mastra",
    file: "mastra.spans.json",
    captureScript: "npm run capture:mastra",
  },
  {
    name: "langgraph",
    file: "langgraph.spans.json",
    captureScript: "npm run capture:langgraph",
  },
];

function loadFixture(file: string, captureScript: string): ReadableSpanLike[] {
  const path = resolve(FIXTURES_DIR, file);
  if (!existsSync(path)) {
    throw new Error(
      `Fixture missing: ${path}\n` +
        `Run \`${captureScript}\` to produce it. The mapper test runs only against ` +
        `real captured spans — synthetic fixtures are explicitly disallowed.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Fixture ${file} is empty or malformed`);
  }
  return parsed as ReadableSpanLike[];
}

interface MappedFixture {
  name: string;
  raw: ReadableSpanLike[];
  events: CanonicalEvent[];
  chat: CanonicalEvent | undefined;
  tool: CanonicalEvent | undefined;
}

const mapped: MappedFixture[] = [];

beforeAll(() => {
  for (const fx of FIXTURES) {
    const raw = loadFixture(fx.file, fx.captureScript);
    const events = raw.map((s) => spanToCanonical(s));
    mapped.push({
      name: fx.name,
      raw,
      events,
      chat: events.find((e) => e.operation === "chat"),
      tool: events.find((e) => e.operation === "execute_tool"),
    });
  }
});

for (const fx of FIXTURES) {
  describe(`fixture: ${fx.name}`, () => {
    const getMapped = (): MappedFixture => {
      const m = mapped.find((x) => x.name === fx.name);
      if (!m) throw new Error(`Fixture ${fx.name} not loaded`);
      return m;
    };

    it("produces a chat canonical event with model, provider, tokens, latency", () => {
      const chat = getMapped().chat;
      expect(chat, "expected a chat-operation span in the fixture").toBeDefined();
      expect(chat!.model, "model").toBeTypeOf("string");
      expect(chat!.model!.length).toBeGreaterThan(0);
      expect(chat!.provider, "provider").toBeTypeOf("string");
      expect(chat!.input_tokens, "input_tokens").toBeTypeOf("number");
      expect(chat!.output_tokens, "output_tokens").toBeTypeOf("number");
      expect(chat!.latency_ms, "latency_ms").toBeGreaterThanOrEqual(0);
    });

    it("preserves raw OTel attributes losslessly", () => {
      const { chat, events } = getMapped();
      expect(chat).toBeDefined();
      const chatIdx = events.indexOf(chat!);
      const sourceAttrs = getMapped().raw[chatIdx]?.attributes ?? {};
      for (const [k, v] of Object.entries(sourceAttrs)) {
        expect(chat!.raw_otel_attrs[k], `attr ${k} preserved`).toEqual(v);
      }
    });

    it("captures conversation turns (events OR Vercel attribute fallback)", () => {
      const chat = getMapped().chat;
      expect(chat).toBeDefined();
      expect(Array.isArray(chat!.turns)).toBe(true);
      const roles = chat!.turns!.map((t) => t.role);
      expect(roles).toContain("system");
      expect(roles).toContain("user");
    });

    it("captures tool calls when the model invoked a tool", () => {
      const { chat, tool } = getMapped();
      // The fixture's chat span finished with tool_calls; either the chat
      // event surfaces the calls, or the separate execute_tool span does.
      const hasToolOnChat = (chat?.tool_calls?.length ?? 0) > 0;
      const hasToolSpan = tool !== undefined;
      expect(hasToolOnChat || hasToolSpan).toBe(true);
      if (tool) {
        expect(tool.tool_calls?.[0]?.name).toBeTypeOf("string");
      }
    });

    it("derives conversation_id and turn_id from span context", () => {
      const chat = getMapped().chat;
      expect(chat).toBeDefined();
      expect(chat!.conversation_id.length).toBeGreaterThan(0);
      expect(chat!.turn_id.length).toBeGreaterThan(0);
    });

    it("emits an ISO timestamp", () => {
      const chat = getMapped().chat;
      expect(chat).toBeDefined();
      expect(() => new Date(chat!.ts).toISOString()).not.toThrow();
    });
  });
}

// Cross-fixture structural equivalence — the real claim of the architecture.
// With one fixture this is tautological; with three it proves the single
// mapper normalizes all frameworks to the same canonical shape. The check
// is written to be meaningful the moment a second fixture lands.
describe("structural equivalence across frameworks", () => {
  it("every fixture's chat event has the same populated-field set", () => {
    const chats = mapped.map((m) => m.chat).filter((c): c is CanonicalEvent => !!c);
    expect(chats.length).toBe(FIXTURES.length);

    const populated = (e: CanonicalEvent): string[] =>
      (
        [
          "conversation_id",
          "turn_id",
          "operation",
          "model",
          "provider",
          "input_tokens",
          "output_tokens",
          "latency_ms",
          "framework",
          "service_name",
          "session_id",
          "ts",
        ] as const
      )
        .filter((k) => e[k] !== undefined && e[k] !== "")
        .sort();

    const sets = chats.map(populated);
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i], `fixture ${mapped[i]?.name} differs from ${mapped[0]?.name}`).toEqual(
        sets[0],
      );
    }
  });
});
