"""Shared helpers for the LangGraph Azure tracer examples."""

from __future__ import annotations


def patch_azure_tracer_compat() -> None:
    """Patch narrow OTel prerelease gaps before importing the Azure tracer."""

    from opentelemetry.semconv._incubating.attributes import gen_ai_attributes
    from opentelemetry.semconv.schemas import Schemas

    constants = {
        "GEN_AI_TOOL_CALL_ARGUMENTS": "gen_ai.tool.call.arguments",
        "GEN_AI_TOOL_CALL_ID": "gen_ai.tool.call.id",
        "GEN_AI_TOOL_CALL_RESULT": "gen_ai.tool.call.result",
        "GEN_AI_TOOL_DEFINITIONS": "gen_ai.tool.definitions",
        "GEN_AI_TOOL_DESCRIPTION": "gen_ai.tool.description",
        "GEN_AI_TOOL_NAME": "gen_ai.tool.name",
        "GEN_AI_TOOL_TYPE": "gen_ai.tool.type",
    }
    for name, value in constants.items():
        if not hasattr(gen_ai_attributes, name):
            setattr(gen_ai_attributes, name, value)

    if not hasattr(Schemas, "V1_38_0"):
        setattr(Schemas, "V1_38_0", Schemas.V1_37_0)
