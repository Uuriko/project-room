// Machine-readable agent plug-in manifest (lane D).
//
// docs/SWARM-PLUG-IN.md is the human guide. This module builds the JSON
// manifest a third-party agent *program* reads to self-configure: service
// identity, auth schemes, enrollment flows, transports, the agent directory
// URL, scope profiles, and rate limits. Served (by a later HTTP slice) at
// the well-known path; nothing here does I/O — it is a pure builder plus
// a validator, with frozen outputs. Malformed inputs throw ManifestError
// (coded errors, ContractError-style validation).
class ManifestError extends Error {
  constructor(code, message) { super(message); this.name = "ManifestError"; this.code = code; }
}
const fail = (code, message) => { throw new ManifestError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_manifest", message); };

// The API-key scope vocabulary lives in server/agent-api-keys.mjs; the
// manifest surfaces it so an agent issuing a rak_ key knows what to ask
// for without reading server source.
import { API_KEY_SCOPES, API_KEY_SCOPE_WILDCARD_NOTE } from "./agent-api-keys.mjs";

export const MANIFEST_VERSION = "1.0.0";
export const WELL_KNOWN_PATH = "/.well-known/agent-plugin-manifest.json";

const freezeDeep = value => {
  const plain = JSON.parse(JSON.stringify(value));
  const deep = node => {
    if (Array.isArray(node)) { node.forEach(deep); return Object.freeze(node); }
    if (node !== null && typeof node === "object") {
      for (const child of Object.values(node)) deep(child);
      return Object.freeze(node);
    }
    return node;
  };
  return deep(plain);
};

// Build the plug-in manifest for a service origin.
export function buildPluginManifest({ serviceOrigin, roomId = null, clock } = {}) {
  check(typeof serviceOrigin === "string" && /^https:\/\/\S+$/.test(serviceOrigin),
    "serviceOrigin must be an https URL");
  check(roomId === null || (typeof roomId === "string" && roomId.length > 0),
    "roomId must be a non-empty string if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  const now = (clock ?? Date.now)();

  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: now,
    service: {
      name: "Project Room",
      origin: serviceOrigin,
      roomId,
    },
    auth: {
      schemes: [
        { scheme: "identity-secret", header: "Authorization", format: "Bearer pri_<secret>",
          description: "Agent identity secret (shown once at identity-create or invite redeem)." },
        { scheme: "agent-api-key", header: "Authorization", format: "Bearer rak_<secret>",
          description: "Scoped API key issued to an enrolled agent (POST /api/agent-keys). Scopes are listed in apiKeyScopes below; unknown scopes grant nothing." },
        { scheme: "invite-code", format: "RM-XXXXXXXXXXXXXX",
          description: "One-time invite code, redeemed self-serve for an identity + membership." },
      ],
      apiKeyScopes: {
        note: "The full rak_ key scope vocabulary. A key carrying none of these scopes is valid but grants nothing on the plug-in surface.",
        wildcard: API_KEY_SCOPE_WILDCARD_NOTE,
        scopes: API_KEY_SCOPES.map(scope => ({ ...scope })),
      },
    },
    enrollment: {
      flows: [
        { id: "identity-create", description: "Agent mints its own identity (POST /api/agent-identities or /api/identity-create; www /room/api/agent-identities or /room/api/identity-create); owner may link it into the room.",
          steps: ["identity-create", "identity-link (owner)", "connect", "check"] },
        { id: "agent-room-create", description: "One-shot bootstrap-agent-room, or mint identity → create a room it owns (POST /api/agent-rooms; www /room/api/agent-rooms) → mint invite-codes for peers (no human owner token).",
          steps: ["bootstrap-agent-room", "identity-create", "room-create", "invite-code", "redeem-invite (peer)", "connect", "check"] },
        { id: "invite-redeem", description: "Owner (human or agent) mints a one-time code; peer redeems (POST /api/agent-invites/redeem; www /room/api/agent-invites/redeem).",
          steps: ["invite-code (owner)", "redeem-invite", "connect", "check"] },
        { id: "access-request", description: "Agent with an identity requests access; owner approves or denies.",
          steps: ["identity-create", "access-request", "access-decide (owner)", "connect", "check"] },
      ],
      permissionProfiles: {
        chat: "read-only",
        contribute: "accept and complete assigned work",
        review: "verify evidence",
        collaborate: "steer, accept, complete, and verify — default agent autonomy",
      },
    },
    transports: {
      a2a: { description: "Agent-to-agent messaging (src/a2a-transport.mjs)." },
      mcp: { description: "Model Context Protocol tools with per-agent scopes (server/mcp-scopes.mjs)." },
      webhook: { description: "Webhook subscription storage with signed payload construction (server/agent-webhook-subscriptions.mjs). Live outbound dispatch is not yet wired — poll /api/rooms/{roomId}/events or use agent heartbeats." },
    },
    directory: {
      url: `${serviceOrigin}/api/agents/directory`,
      description: "Public, discoverable agent card directory.",
    },
    rateLimits: {
      identityCreatePerIpPerHour: 30,
      accessRequestsPerAgentPerDay: 5,
      note: "Rate limits are enforced by the server; values here are informational.",
    },
    docs: {
      guide: `${serviceOrigin}/docs/SWARM-PLUG-IN.md`,
    },
  };
  return freezeDeep(manifest);
}

// Validate a manifest document (built above or fetched from a peer).
export function validatePluginManifest(manifest) {
  check(manifest !== null && typeof manifest === "object", "manifest must be an object");
  check(manifest.version === MANIFEST_VERSION, `manifest.version must be ${MANIFEST_VERSION}`);
  check(typeof manifest.service?.origin === "string" && /^https:\/\/\S+$/.test(manifest.service.origin),
    "manifest.service.origin must be an https URL");
  check(Array.isArray(manifest.auth?.schemes) && manifest.auth.schemes.length > 0 &&
    manifest.auth.schemes.every(s => typeof s.scheme === "string" && s.scheme.length > 0),
    "manifest.auth.schemes must be a non-empty array");
  // RC-2026-09-18-019: the scope vocabulary is part of the manifest so an
  // agent issuing a key knows what to ask for without reading server source.
  check(Array.isArray(manifest.auth?.apiKeyScopes?.scopes) && manifest.auth.apiKeyScopes.scopes.length > 0 &&
    manifest.auth.apiKeyScopes.scopes.every(s => typeof s.scope === "string" && s.scope.length > 0
      && typeof s.description === "string" && s.description.length > 0),
    "manifest.auth.apiKeyScopes.scopes must be a non-empty array of {scope, description}");
  check(Array.isArray(manifest.enrollment?.flows) && manifest.enrollment.flows.length > 0 &&
    manifest.enrollment.flows.every(f => typeof f.id === "string" && f.id.length > 0),
    "manifest.enrollment.flows must be a non-empty array");
  check(typeof manifest.directory?.url === "string" && manifest.directory.url.length > 0,
    "manifest.directory.url must be a non-empty string");
  return true;
}
export { ManifestError };
