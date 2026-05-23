import { randomUUID } from "node:crypto";
import type { Identity } from "./schema.js";

// Namespace under which we stamp our identity on every span. Chosen so a
// downstream OTel pipeline can see at a glance that these attrs are
// Agnost-added, not framework-emitted.
export const AGNOST_ATTR_PREFIX = "agnost.";

export interface IdentityInput {
  project_id?: string;
  session_id?: string;
  user_id?: string;
  framework?: string;
  service_name: string;
}

export function buildIdentity(input: IdentityInput): Identity {
  return {
    project_id: input.project_id,
    session_id: input.session_id ?? randomUUID(),
    user_id: input.user_id,
    framework: input.framework ?? "unknown",
    service_name: input.service_name,
  };
}

export function identityToAttrs(id: Identity): Record<string, string> {
  const out: Record<string, string> = {
    [`${AGNOST_ATTR_PREFIX}session_id`]: id.session_id,
    [`${AGNOST_ATTR_PREFIX}framework`]: id.framework,
    [`${AGNOST_ATTR_PREFIX}service_name`]: id.service_name,
  };
  if (id.project_id) out[`${AGNOST_ATTR_PREFIX}project_id`] = id.project_id;
  if (id.user_id) out[`${AGNOST_ATTR_PREFIX}user_id`] = id.user_id;
  return out;
}

export function attrsToIdentity(
  attrs: Record<string, unknown>,
): Partial<Identity> {
  const get = (key: string): string | undefined => {
    const v = attrs[`${AGNOST_ATTR_PREFIX}${key}`];
    return typeof v === "string" ? v : undefined;
  };
  return {
    project_id: get("project_id"),
    session_id: get("session_id") ?? "",
    user_id: get("user_id"),
    framework: get("framework") ?? "unknown",
    service_name: get("service_name") ?? "unknown",
  };
}
