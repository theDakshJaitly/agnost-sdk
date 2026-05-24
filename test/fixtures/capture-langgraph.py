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
"""Capture real LangGraph spans emitted by AzureAIOpenTelemetryTracer.

This intentionally uses the Azure tracer path, not LangSmith/OpenLLMetry.
The resulting JSON fixture is consumed by the TypeScript mapper test.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any

warnings.filterwarnings("ignore", message="create_react_agent has been moved.*")

sys.path.append(str(Path(__file__).resolve().parents[2] / "examples"))
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


FIXTURE_PATH = Path(__file__).with_name("langgraph.spans.json")
MODEL = os.environ.get("AGNOST_CAPTURE_MODEL", "qwen/qwen3-32b")


@tool
def get_weather(city: str) -> dict[str, Any]:
    """Get current weather for a city."""

    return {"city": city, "temp_c": 17, "sky": "cloudy"}


def json_default(value: Any) -> Any:
    if hasattr(value, "value"):
        return value.value
    return str(value)


def hex_id(value: int, width: int) -> str:
    return f"{value:0{width}x}"


def serialize_span(span: Any) -> dict[str, Any]:
    ctx = span.get_span_context()
    parent = span.parent
    return {
        "name": span.name,
        "kind": getattr(span.kind, "value", span.kind),
        "attributes": dict(span.attributes or {}),
        "events": [
            {
                "name": event.name,
                "attributes": dict(event.attributes or {}),
                "time": event.timestamp / 1_000_000,
            }
            for event in span.events
        ],
        "startTime": span.start_time / 1_000_000,
        "endTime": span.end_time / 1_000_000,
        "status": {"code": getattr(span.status.status_code, "value", span.status.status_code)},
        "traceId": hex_id(ctx.trace_id, 32),
        "spanId": hex_id(ctx.span_id, 16),
        "parentSpanId": hex_id(parent.span_id, 16) if parent else None,
    }


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("[capture-langgraph] OPENAI_API_KEY not set.")

    exporter = InMemorySpanExporter()
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": "agnost-capture-langgraph",
                "agnost.framework": "langgraph",
                "agnost.session_id": "capture-langgraph",
            }
        )
    )
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

    agent.invoke(
        {
            "messages": [
                HumanMessage(
                    content=(
                        "What's the weather in Paris today? "
                        "My email is jane.doe@example.com."
                    )
                )
            ]
        },
        config={
            "callbacks": [tracer],
            "configurable": {"thread_id": "capture-langgraph"},
            "recursion_limit": 4,
        },
    )

    provider.force_flush()
    spans = exporter.get_finished_spans()
    FIXTURE_PATH.write_text(
        json.dumps([serialize_span(s) for s in spans], indent=2, default=json_default),
        encoding="utf8",
    )
    print(f"[capture-langgraph] wrote {len(spans)} span(s) to {FIXTURE_PATH}")
    provider.shutdown()


if __name__ == "__main__":
    main()
