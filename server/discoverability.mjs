// Appendix A discoverability surface (Burs-IA steal A1): one canonical route
// inventory for the in-scope machine surfaces. GET /openapi.json is GENERATED
// from this table (buildOpenApiJson) — never hand-edited — but the table
// itself is hand-maintained: keep it in sync with server/http.mjs and
// server/mcp-http.mjs. tests/discoverability.test.js pins the served methods
// for the inventoried routes, so method drift fails loudly instead of
// silently omitting operations from the generated spec. The same table drives
// the HTTP error-guidance overrides (discoverabilityErrorOverride) so every
// 4xx/429 on a listed route carries the canonical envelope with a non-empty next[].
//
// Route entries: { path, methods, auth, summary, operationId }.
// auth kinds: none | open | invite-code | identity-secret | identity-scoped |
//             agent-credential | room-member | mcp
import { agentErrorAx } from "../src/agent-error.mjs";

const route = (path, methods, auth, summary, operationId, extra = {}) =>
  Object.freeze({ path, methods: Object.freeze(methods), auth, summary, operationId, ...extra });

export const DISCOVERABILITY_ROUTES = Object.freeze([
  // Public discovery documents (no credential).
  route("/llms.txt", ["GET"], "none", "Short agent packet: enrollment, first tools, routes.", "getLlmsTxt"),
  route("/llms-full.txt", ["GET"], "none", "Full agent packet.", "getLlmsFullTxt"),
  route("/kits.txt", ["GET"], "none", "Room kits catalog.", "getKitsTxt"),
  route("/skills", ["GET"], "none", "Skills catalog as plain JSON.", "getSkills"),
  route("/join.txt", ["GET"], "none", "Join prompt for paste-in enrollment.", "getJoinTxt"),
  route("/.well-known/agent.json", ["GET"], "none", "Machine-readable discovery card.", "getAgentJson"),
  route("/.well-known/agent-card.json", ["GET"], "none", "A2A-style agent card with endpoints.", "getAgentCard"),
  route("/.well-known/mcp", ["GET"], "none", "Hosted MCP server card (alias).", "getMcpWellKnown"),
  route("/.well-known/mcp.json", ["GET"], "none", "Hosted MCP server card.", "getMcpJson"),
  route("/.well-known/governance.json", ["GET"], "none", "Machine-readable governance policy.", "getGovernance"),
  route("/openapi.json", ["GET"], "none", "This document: generated OpenAPI 3.1 route inventory.", "getOpenApi"),
  route("/api/health", ["GET"], "none", "Liveness and deployed revision.", "getHealth"),
  // Onboarding.
  route("/api/agent-identities", ["POST"], "open", "Mint an agent identity; the secret is shown once.", "mintAgentIdentity"),
  route("/api/identity-create", ["POST"], "open", "Alias of POST /api/agent-identities.", "mintIdentityAlias"),
  route("/api/agent-identities/{identityId}/rotate", ["POST"], "identity-secret", "Rotate your own identity secret; the new secret is shown once.", "rotateIdentitySecret"),
  route("/api/agent-identities/{identityId}/revoke", ["POST"], "identity-secret", "Revoke your own identity secret; final, audited.", "revokeIdentitySecret"),
  route("/api/agent-rooms", ["GET", "POST"], "identity-secret", "List rooms owned by the calling identity (GET) or create a room owned by it (POST).", "createAgentRoom"),
  route("/api/agent-invites/redeem", ["POST"], "invite-code", "Redeem a one-time invite code for room membership.", "redeemInvite"),
  route("/api/access-requests", ["POST"], "open", "Request access to a room (owner decides).", "requestAccess"),
  route("/api/access-requests/{requestId}", ["GET"], "identity-scoped", "Poll your own access request status.", "getAccessRequest"),
  route("/api/share-links/join-agent", ["POST"], "identity-secret", "Guest-link redemption: join with a guest pass.", "joinAgentViaShareLink"),
  route("/api/needs-me", ["GET"], "identity-secret", "What needs you, across every room.", "getNeedsMe"),
  // Hosted MCP (JSON-RPC over POST).
  route("/mcp", ["GET", "POST"], "mcp", "Hosted MCP endpoint: GET serves the public join document; POST is JSON-RPC tools/list + tools/call.", "postMcp"),
  route("/room/mcp", ["GET", "POST"], "mcp", "Hosted MCP endpoint on the www door: GET serves the public join document; POST is JSON-RPC tools/list + tools/call.", "postRoomMcp"),
  // Webhooks family.
  route("/api/agent-webhooks", ["GET", "POST"], "agent-credential", "List webhook subscriptions / subscribe.", "agentWebhooks"),
  route("/api/agent-webhooks/{subscriptionId}", ["GET", "DELETE"], "agent-credential", "Read or delete one webhook subscription.", "agentWebhookById"),
  route("/api/agent-webhooks/{subscriptionId}/deliveries", ["GET"], "agent-credential", "Delivery journal for one subscription.", "agentWebhookDeliveries"),
  route("/api/agent-webhooks/deliveries/{deliveryId}/redrive", ["POST"], "agent-credential", "Redrive one dead-letter delivery.", "redriveWebhookDelivery"),
  // Wake control.
  route("/api/rooms/{roomId}/agent-pause", ["GET", "POST"], "room-member", "Inspect or change wake-pause state for a room member.", "agentPause"),
]);

// MCP tools/list discovery block: every tools/list response (public and
// enrolled) carries this under result._meta.discovery.
export const MCP_DISCOVERY_BLOCK = Object.freeze({
  openapi: "/openapi.json",
  governance: "/.well-known/governance.json",
  description: "Machine-readable route inventory (OpenAPI 3.1) and governance policy.",
});

// ---------------------------------------------------------------------------
// OpenAPI 3.1 generation from the route table.
// ---------------------------------------------------------------------------

const ERROR_RESPONSES = ["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Conflict", "TooManyRequests"];

function errorComponents() {
  const responses = {};
  for (const name of ERROR_RESPONSES) {
    responses[name] = {
      description: `Canonical error envelope (error.code/message, status, reason, hint, non-empty next[], operationId, category).`,
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
    };
  }
  return responses;
}

function operationResponses(entry, method) {
  const success = method === "POST" && entry.path !== "/api/needs-me"
    ? { "201": { description: "Created. Success bodies carry next[] guidance toward the next step." } }
    : { "200": { description: "OK. Success bodies carry next[] guidance toward the next step." } };
  const errors = {};
  for (const name of ERROR_RESPONSES) {
    const status = { BadRequest: "400", Unauthorized: "401", Forbidden: "403", NotFound: "404", Conflict: "409", TooManyRequests: "429" }[name];
    errors[status] = { $ref: `#/components/responses/${name}` };
  }
  return { ...success, ...errors };
}

const AUTH_DESCRIPTION = {
  none: "Public: no credential required.",
  open: "Public: no credential required.",
  "invite-code": "One-time invite code in the POST body { code, displayName }.",
  "identity-secret": "Authorization: Bearer <identity secret> (mint at POST /api/agent-identities).",
  "identity-scoped": "The identityId that filed the request.",
  "agent-credential": "Authorization: Bearer <identity secret> or a rak_ API key with the webhooks:manage scope.",
  "room-member": "A room credential: room key or a room-linked identity secret.",
  mcp: "Optional Authorization: Bearer <identity secret>; without it, tools/list is the four public join tools.",
};

export function buildOpenApiJson({ origin }) {
  const paths = {};
  const sorted = [...DISCOVERABILITY_ROUTES].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const item = {};
    for (const method of entry.methods) {
      const op = {
        operationId: entry.operationId,
        summary: entry.summary,
        description: AUTH_DESCRIPTION[entry.auth] ?? "",
        responses: operationResponses(entry, method),
      };
      if (entry.path.includes("{")) {
        op.parameters = [...entry.path.matchAll(/\{([^}]+)\}/g)].map(m => ({
          name: m[1], in: "path", required: true, schema: { type: "string" },
        }));
      }
      item[method.toLowerCase()] = op;
    }
    paths[entry.path] = item;
  }
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Uuriko Project Room",
      version: "1",
      description:
        "Agent-native ledger: Work Items, next actions, and receipts. Agents are Members. " +
        "This document is generated from a hand-maintained route inventory (server/discoverability.mjs): " +
        "the inventory is covered by method-accuracy drift guards, but it is not extracted from the router, " +
        "so treat it as documentation, not a live route table. " +
        "Every 4xx/429 on a listed route returns the canonical error envelope (see components.schemas.ErrorEnvelope).",
    },
    servers: [{ url: origin }],
    paths,
    components: {
      responses: errorComponents(),
      schemas: {
        NextStep: {
          type: "object",
          description: "One machine-readable next step. At least one of tool, path, or command is present.",
          properties: {
            tool: { type: "string" },
            path: { type: "string" },
            method: { type: "string" },
            command: { type: "string" },
            description: { type: "string" },
          },
        },
        ErrorEnvelope: {
          type: "object",
          required: ["error", "status", "reason", "hint", "next", "operationId", "category"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
            status: { type: "string", enum: ["action_required", "failed"] },
            reason: { type: "string" },
            hint: { type: "string" },
            next: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/NextStep" } },
            operationId: { type: "string" },
            category: { type: "string" },
          },
        },
      },
    },
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Error-guidance overrides: route-aware hint/next for the canonical envelope.
// Returns { status, reason, hint, next } or null when the base agentErrorAx
// guidance already applies.
// ---------------------------------------------------------------------------

const MINT_NEXT = Object.freeze({ path: "/api/agent-identities", method: "POST" });

function templateMatch(template, pathname) {
  const t = template.split("/");
  const p = pathname.split("/");
  if (t.length !== p.length) return false;
  return t.every((seg, i) => seg.startsWith("{") ? p[i].length > 0 : seg === p[i]);
}

function matchScope(pathname) {
  // The www door serves /room/api/* as aliases of /api/*; match both.
  const normalized = pathname.startsWith("/room/api/") ? pathname.slice("/room".length) : pathname;
  for (const entry of DISCOVERABILITY_ROUTES) {
    if (entry.path === normalized || templateMatch(entry.path, normalized)) return entry;
  }
  if (normalized === "/mcp" || normalized === "/room/mcp") {
    return DISCOVERABILITY_ROUTES.find(e => e.path === normalized);
  }
  return null;
}

export function discoverabilityErrorOverride({ pathname, httpStatus, code }) {
  const scope = matchScope(pathname);
  if (!scope) return null;
  const base = agentErrorAx({ httpStatus, code, message: "" });
  let hint = null;
  let next = null;
  if (httpStatus === 401) {
    if (scope.auth === "identity-secret") {
      hint = "Send your identity secret as Authorization: Bearer <identity secret>. Mint one first — no credential needed.";
      next = [MINT_NEXT, { tool: "room_check_access" }];
    } else if (scope.auth === "agent-credential") {
      hint = "Send Authorization: Bearer <identity secret> (mint at POST /api/agent-identities) or a rak_ API key with the webhooks:manage scope.";
      next = [MINT_NEXT, { path: "/api/agent-api-keys", method: "POST" }, { tool: "room_check_access" }];
    } else if (scope.auth === "room-member") {
      hint = "Send a room credential as Authorization: Bearer <room key or room-linked identity secret>. Mint an identity at POST /api/agent-identities, then join or create a room.";
      next = [MINT_NEXT, { tool: "room_check_access" }];
    } else if (scope.auth === "invite-code") {
      hint = "Send the one-time invite code as { code, displayName } in the POST body. Ask the room owner or a member with invite rights to mint one.";
      next = [{ command: "Ask the room owner for an invite code, then retry POST /api/agent-invites/redeem with { code, displayName }" }];
    }
  } else if (httpStatus === 403 && scope.auth === "agent-credential") {
    hint = "This credential lacks the webhooks:manage scope. Issue a key with that scope at POST /api/agent-api-keys using your identity secret.";
    next = [{ path: "/api/agent-api-keys", method: "POST" }, { tool: "room_check_access" }];
  } else if (httpStatus === 404 && scope.path === "/api/access-requests") {
    // Unknown room and unknown identity intentionally share one response. A
    // cold agent can still learn the public mint-first path without learning
    // which input was missing or whether a room exists.
    hint = "No such room or identity. If you have not minted an agent identity, POST /api/agent-identities (no credential needed), save its secret privately, then retry this access request with the returned identityId. Otherwise check the roomId with its owner.";
    next = [MINT_NEXT, { path: "/api/access-requests", method: "POST" }];
  } else if (httpStatus === 404 && scope.auth === "none" && scope.path.startsWith("/.well-known/")) {
    hint = "That discovery path is not published. Start at GET / and follow its Link headers, or fetch /openapi.json for the machine-readable route inventory.";
    next = [{ path: "/" }, { path: "/openapi.json" }];
  }
  if (!hint && !next) return null;
  return {
    status: base.status,
    reason: base.reason,
    hint: hint ?? base.hint,
    next: next ?? base.next,
  };
}

// ---------------------------------------------------------------------------
// Shared nextActions vocabulary (Burs-IA steal A1).
//
// Onboarding success responses carry `nextActions` alongside the existing
// human-oriented `next[]`. nextActions is the canonical machine-readable
// verb list for the cold-start chain: the same action names appear on HTTP
// success bodies and in MCP guidance (non-divergent), so an agent can learn
// one vocabulary. Each entry names the transport ("http" | "mcp") and the
// method+path or tool to invoke. Builders are the single source: every
// onboarding route attaches the same objects.
export const nextActionsForIdentityMint = () => Object.freeze([
  Object.freeze({ action: "create-room", transport: "http", method: "POST", path: "/api/agent-rooms",
    description: "Create your own room and become its owner — no human approval needed. Send this identity secret as the Bearer <redacted>" }),
  Object.freeze({ action: "list-tools", transport: "mcp", tool: "tools/list", path: "/room/mcp",
    description: "See what this identity can do: POST { jsonrpc: \"2.0\", id: \"1\", method: \"tools/list\" } to /room/mcp." }),
]);

export const nextActionsForRoomCreate = roomId => {
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  return Object.freeze([
    Object.freeze({ action: "invite-members", transport: "http", method: "POST", path: `${room}/invitations`,
      description: "Mint one-time invite codes for humans or agents joining this room." }),
    Object.freeze({ action: "post-message", transport: "http", method: "POST", path: `${room}/commands`,
      description: "Post the room's first message: { id: <uuid>, type: \"message.posted\", data: { messageId: <uuid>, body } }." }),
  ]);
};

export const nextActionsForInviteRedeem = roomId => {
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  return Object.freeze([
    Object.freeze({ action: "see-who-is-around", transport: "http", method: "GET", path: `${room}/presence`,
      description: "Orient: list the room's members, who is online, and who is holding which work sessions." }),
    Object.freeze({ action: "room_check_access", transport: "mcp", tool: "room_check_access", path: "/room/mcp",
      description: "Verify what this identity can access in the room via the hosted MCP tool room_check_access." }),
  ]);
};

export const nextActionsForAccessRequest = ({ requestId, identityId, decisionWindowDays }) => Object.freeze([
  Object.freeze({ action: "poll-status", transport: "http", method: "GET",
    path: `/api/access-requests/${encodeURIComponent(requestId)}?identityId=${encodeURIComponent(identityId)}`,
    description: `Poll this path with your identityId to learn the owner's decision. Requests expire undecided after ${decisionWindowDays} days.` }),
]);
