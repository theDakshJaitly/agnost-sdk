import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { instrument as baseInstrument, type InstrumentHandle, type InstrumentOptions } from "../core/instrument.js";

// OpenAI profile.
//
// The OpenAI Node SDK does NOT emit OpenTelemetry natively as of 2026.
// Until it does, this profile provides a minimal `wrapOpenAI()` helper
// that emits GenAI-convention spans around `chat.completions.create`.
//
// The wrapper is intentionally narrow:
//   - Only `chat.completions.create` is intercepted.
//   - The rest of the client object is passed through untouched.
//   - All non-streaming responses are handled; streaming would need
//     additional event-emission and is left for P1.5.
//   - If no tracer provider is registered (instrument() not called),
//     the spans go to the no-op global tracer — silent no-op.
//
// As OpenAI ships native OTel, this file shrinks to a no-op re-export of
// `instrument()`. That shrinkage is the test of the SDK's thesis: when
// the standard wins, profile code goes away.

export function instrument(opts: Omit<InstrumentOptions, "framework">): InstrumentHandle {
  return baseInstrument({ ...opts, framework: "openai" });
}

// We don't depend on the `openai` package at type level so this profile
// stays installable without forcing a particular openai version. The
// runtime contract: the client has a `chat.completions.create` callable.
// Generics preserve the caller's concrete OpenAI client type on the
// wrapper's output so user code keeps full OpenAI typings.

type AnyMessage = { role?: string; content?: string };

function eventAttrsForMessage(m: AnyMessage): Record<string, string> {
  const out: Record<string, string> = {};
  if (m.role) out["role"] = m.role;
  if (m.content) out["content"] = m.content;
  return out;
}

// Wrap an OpenAI client so `chat.completions.create` emits a single
// GenAI-convention `chat <model>` span per call. The wrapper preserves
// the original return value (including streams — though stream-content
// is not emitted as events yet) and the caller's concrete client type.
export function wrapOpenAI<T extends object>(client: T): T {
  const tracer = trace.getTracer("@agnost/sdk/openai", "0.0.1");

  const wrappedCreate = async (...args: unknown[]): Promise<unknown> => {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const model = typeof params["model"] === "string" ? (params["model"] as string) : "unknown";
    const messages = Array.isArray(params["messages"]) ? (params["messages"] as AnyMessage[]) : [];

    const span = tracer.startSpan(`chat ${model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.system": "openai",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": model,
      },
    });

    try {
      for (const m of messages) {
        if (!m.role) continue;
        span.addEvent(`gen_ai.${m.role}.message`, eventAttrsForMessage(m));
      }

      // Call the underlying create via the original client. Cast is
      // local — public API of wrapOpenAI is fully typed via the T generic.
      const create = (client as { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } })
        .chat.completions.create;
      const result = await create.apply(
        (client as { chat: { completions: unknown } }).chat.completions,
        args,
      );

      // Best-effort response-attribute extraction. Streams pass through
      // untouched; for non-stream responses we record tokens + finish
      // reason + the assistant choice.
      const r = result as {
        model?: string;
        id?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: { finish_reason?: string; message?: { role?: string; content?: string | null; tool_calls?: unknown[] } }[];
      };
      if (r && typeof r === "object" && !("[Symbol.asyncIterator]" in r)) {
        if (r.model) span.setAttribute("gen_ai.response.model", r.model);
        if (r.id) span.setAttribute("gen_ai.response.id", r.id);
        if (r.usage?.prompt_tokens !== undefined) {
          span.setAttribute("gen_ai.usage.input_tokens", r.usage.prompt_tokens);
        }
        if (r.usage?.completion_tokens !== undefined) {
          span.setAttribute("gen_ai.usage.output_tokens", r.usage.completion_tokens);
        }
        if (r.choices?.length) {
          span.setAttribute(
            "gen_ai.response.finish_reasons",
            r.choices.map((c) => c.finish_reason ?? "stop"),
          );
          const choice = r.choices[0];
          if (choice) {
            const choiceAttrs: Record<string, string | number> = {
              "gen_ai.system": "openai",
              index: 0,
              finish_reason: choice.finish_reason ?? "stop",
            };
            if (choice.message?.role) choiceAttrs["role"] = choice.message.role;
            if (choice.message?.content) choiceAttrs["content"] = choice.message.content;
            if (choice.message?.tool_calls) {
              choiceAttrs["tool_calls"] = JSON.stringify(choice.message.tool_calls);
            }
            span.addEvent("gen_ai.choice", choiceAttrs);
          }
        }
      }

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  };

  // Replace just the create method on a shallow proxy. Everything else
  // on the client passes through untouched, including new methods added
  // by future OpenAI SDK versions.
  const clientWithChat = client as unknown as {
    chat: { completions: object };
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "chat") return Reflect.get(target, prop, receiver);
      return new Proxy(clientWithChat.chat, {
        get(chatTarget, chatProp, chatReceiver) {
          if (chatProp !== "completions") return Reflect.get(chatTarget, chatProp, chatReceiver);
          return new Proxy(clientWithChat.chat.completions, {
            get(compTarget, compProp, compReceiver) {
              if (compProp !== "create") return Reflect.get(compTarget, compProp, compReceiver);
              return wrappedCreate;
            },
          });
        },
      });
    },
  });
}
