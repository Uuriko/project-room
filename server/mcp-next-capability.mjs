// Effective capability of THIS connection for the step a selected work read
// suggests. A read-only projection of checks that already exist elsewhere:
// Room authority (workActions, carried on continuation.capability.room), the
// OAuth tool allowlist (mcpOAuthToolAllowed), the API-key room scope gate and
// the catalog tier filter (catalogCallDenial). It grants nothing, stores
// nothing and never names token values or other members' grants. The service
// still validates revision, evidence version and independence at submission.
import { mcpOAuthToolAllowed } from "./mcp-oauth.mjs";
import { OAUTH_SCOPES } from "./oauth-provider.mjs";

// Stage tools an OAuth connection may use when the composite begin is not offered.
const BEGIN_STAGES = Object.freeze({
  accept: { tool: "room_accept_work", inputRequired: [] },
  start: { tool: "room_start_work", inputRequired: [] },
  claim: { tool: "room_acquire_claim", inputRequired: ["repository", "ref", "paths", "expiresAt"] },
});

// Scopes every consent would need for `tool`, derived only from mcpOAuthToolAllowed.
export function oauthScopesForTool(tool, allowed = mcpOAuthToolAllowed, scopes = OAUTH_SCOPES) {
  if (!allowed(tool, [...scopes])) return null; // no consent offers it on this server
  const required = scopes.filter(scope => !allowed(tool, scopes.filter(other => other !== scope)));
  if (required.length > 0) return { allOf: required };
  return { anyOf: scopes.filter(scope => allowed(tool, [scope])) };
}

function grantFor(tool, connection, allowed) {
  if (connection.kind === "oauth") {
    if (allowed(tool, connection.scopes)) return { grant: "allowed" };
    const needed = oauthScopesForTool(tool, allowed);
    if (!needed) return { grant: "not_offered" };
    const missing = needed.allOf ? needed.allOf.filter(scope => !connection.scopes.includes(scope)) : needed.anyOf;
    return { grant: "missing_scope", missingScopes: missing };
  }
  // Identity secrets carry no tool scopes; Room authority decides. API keys
  // are rechecked by the service with their stored scopes: unknown here.
  return { grant: connection.kind === "identity" ? "not_applicable" : "unknown" };
}

// connection: { kind: "oauth"|"identity"|"api_key", scopes?: string[] }
// exposed(tool): true when this server dispatches the tool for this member's tier.
export function connectionCapability(continuation, { connection, exposed, allowed = mcpOAuthToolAllowed }) {
  const base = continuation?.capability;
  if (!base || typeof base.tool !== "string") return continuation;
  const tool = base.tool;
  const isExposed = exposed(tool);
  const grant = isExposed ? grantFor(tool, connection, allowed) : { grant: "unknown" };
  const out = { ...base, connection: { kind: connection.kind, exposed: isExposed, ...grant } };
  // Room-side outcomes are final: a blocked step, a prerequisite wait or an
  // unknown prerequisite observation never becomes callable here.
  if (base.status === "blocked" || base.status === "waiting" || typeof continuation.tool !== "string") return { ...continuation, capability: out };
  const blocked = (blockedBy, recovery, extra = {}) => ({ ...continuation, capability: { ...out, status: "blocked", blockedBy, recovery, ...extra } });
  if (!isExposed) return blocked("catalog", `This member's tier withholds ${tool} on this server; ask the room owner to review the tier. Do not retry the call.`);
  if (grant.grant === "missing_scope") return blocked("oauth_scope",
    `Reconnect this same agent through its host OAuth consent and approve ${grant.missingScopes.join(" ")}; keep the existing identity. ${tool} is refused on this connection until then.`);
  if (grant.grant === "not_offered") {
    const stage = tool === "room_begin_work" && continuation.tool === "room_begin_work" ? BEGIN_STAGES[base.operation] : null;
    const args = continuation.arguments ?? {};
    if (stage && typeof args.workItemId === "string" && allowed(stage.tool, connection.scopes) && exposed(stage.tool)) {
      const alternative = { tool: stage.tool, arguments: { ...(args.roomId ? { roomId: args.roomId } : {}), workItemId: args.workItemId, expectedRevision: continuation.workRevision }, inputRequired: stage.inputRequired };
      return {
        ...continuation,
        ...alternative,
        capability: {
          ...out, tool: stage.tool, connection: { kind: connection.kind, exposed: true, grant: "allowed" },
          status: "available", via: "alternative", alternative, blockedBy: null,
          recovery: "This connection advances one stage per call. Read the task again after this stage."
        }
      };
    }
    return blocked("oauth_not_offered", `This server offers ${tool} to no OAuth consent, so reconnecting will not help. Do not retry here; report the step as blocked on this connection.`);
  }
  if (grant.grant === "unknown") return { ...continuation, capability: { ...out, status: "unknown", blockedBy: null,
    recovery: "This API key's scopes are checked when the call is made; a refusal names the missing scope." } };
  // Listed and permitted for this connection; admission still checks revision, version, role and prerequisites.
  return { ...continuation, capability: { ...out, status: "available", blockedBy: null } };
}

// Annotate every selected-read continuation in a room_read_work value in place-safe copy.
export function withConnectionCapability(value, options) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value.items)) return { ...value, items: value.items.map(item => withConnectionCapability(item, options)) };
  if (!value.continuation) return value;
  return { ...value, continuation: connectionCapability(value.continuation, options) };
}
