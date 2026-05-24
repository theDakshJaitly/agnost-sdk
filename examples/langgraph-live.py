# /// script
# dependencies = [
#   "langchain-azure-ai[opentelemetry]",
#   "langgraph",
#   "langchain-openai",
#   "opentelemetry-api==1.38.0",
#   "opentelemetry-sdk==1.38.0",
#   "opentelemetry-semantic-conventions==0.59b0",
# ]
# ///
"""Live LangGraph demo: Azure OTel tracer -> mock ingest -> viewer."""

from __future__ import annotations

import os
import json
import sys
import urllib.request
import warnings
from typing import Any

from pathlib import Path

warnings.filterwarnings("ignore", message="create_react_agent has been moved.*")

sys.path.append(str(Path(__file__).resolve().parent))
from langgraph_support import patch_azure_tracer_compat  # type: ignore


patch_azure_tracer_compat()

from langchain_azure_ai.callbacks.tracers import AzureAIOpenTelemetryTracer
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)


MODEL = os.environ.get("AGNOST_CAPTURE_MODEL", "qwen/qwen3-32b")
ENDPOINT = os.environ.get("AGNOST_ENDPOINT", "http://127.0.0.1:4318")


@tool
def get_weather(city: str) -> dict[str, Any]:
    """Get current weather for a city."""

    return {"city": city, "temp_c": 17, "sky": "cloudy"}


def stderr(message: str) -> None:
    print(message, file=sys.stderr)


def any_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [any_value(v) for v in value]}}
    if isinstance(value, dict):
        return {
            "kvlistValue": {
                "values": [{"key": str(k), "value": any_value(v)} for k, v in value.items()]
            }
        }
    return {"stringValue": str(value)}


def kv_attrs(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": key, "value": any_value(value)} for key, value in attrs.items()]


def ns(value: int) -> str:
    return str(value)


def hex_id(value: int, width: int) -> str:
    return f"{value:0{width}x}"


def post_otlp_json(spans: list[Any], endpoint: str, resource_attrs: dict[str, Any]) -> None:
    payload = {
        "resourceSpans": [
            {
                "resource": {"attributes": kv_attrs(resource_attrs)},
                "scopeSpans": [
                    {
                        "scope": {"name": "langchain-azure-ai"},
                        "spans": [
                            {
                                "traceId": hex_id(s.get_span_context().trace_id, 32),
                                "spanId": hex_id(s.get_span_context().span_id, 16),
                                "parentSpanId": (
                                    hex_id(s.parent.span_id, 16) if s.parent else ""
                                ),
                                "name": s.name,
                                "kind": getattr(s.kind, "value", s.kind),
                                "startTimeUnixNano": ns(s.start_time),
                                "endTimeUnixNano": ns(s.end_time),
                                "attributes": kv_attrs(dict(s.attributes or {})),
                                "events": [
                                    {
                                        "timeUnixNano": ns(e.timestamp),
                                        "name": e.name,
                                        "attributes": kv_attrs(dict(e.attributes or {})),
                                    }
                                    for e in s.events
                                ],
                                "status": {
                                    "code": getattr(
                                        s.status.status_code,
                                        "value",
                                        s.status.status_code,
                                    )
                                },
                            }
                            for s in spans
                        ],
                    }
                ],
            }
        ]
    }
    data = json.dumps(payload).encode("utf8")
    req = urllib.request.Request(
        f"{endpoint.rstrip('/')}/v1/traces",
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": "Bearer demo-key",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        res.read()


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("[demo:langgraph] OPENAI_API_KEY not set.")

    resource_attrs = {
        "service.name": "agnost-demo-langgraph",
        "agnost.framework": "langgraph",
        "agnost.session_id": "demo-langgraph",
    }
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create(resource_attrs))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    model = ChatOpenAI(
        model=MODEL,
        api_key=os.environ["OPENAI_API_KEY"],
        base_url=os.environ.get("OPENAI_BASE_URL"),
        temperature=0,
    )
    agent = create_react_agent(
        model,
        [get_weather],
        prompt=(
            "You are a helpful weather assistant. Use the tool for weather "
            "questions, then summarize the result to the user."
        ),
    )
    tracer = AzureAIOpenTelemetryTracer(
        enable_content_recording=True,
        provider_name="openai",
        auto_configure_azure_monitor=False,
    )

    stderr("\x1b[2magnost · live LangGraph ingest via Azure OTel tracer\x1b[0m")
    prompt = "What's the weather in Paris today?"
    stderr(f"\x1b[2m[demo:langgraph] Q1: {prompt}\x1b[0m")
    result = agent.invoke(
        {"messages": [HumanMessage(content=prompt)]},
        config={
            "callbacks": [tracer],
            "configurable": {"thread_id": "demo-langgraph"},
            "recursion_limit": 4,
        },
    )
    final = result["messages"][-1]
    if getattr(final, "content", None):
        stderr(f"\x1b[1massistant> {final.content}\x1b[0m")

    provider.force_flush()
    post_otlp_json(exporter.get_finished_spans(), ENDPOINT, resource_attrs)
    provider.shutdown()
    stderr("\x1b[2m[demo:langgraph] done\x1b[0m")


if __name__ == "__main__":
    main()
