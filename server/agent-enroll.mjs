// One-call guest enrollment: POST /api/agents/enroll.
//
// An outside agent with nothing but curl gets, in a single call, everything
// it needs to find the room and start working: an agent identity, a scoped
// 24h guest API key (the existing rak_ machinery, guest-safe scopes only),
// machine-readable discovery URLs, and three starter tasks from the public
// opportunity feed. No repo checkout, no CLI, no owner tap.
//
// The identity's credential (pri_) is NEVER revealed by this route
// (red-team HIGH, RC-2026-09-29-3604): the only usable credential in the
// response is the guest token, which carries ENROLL_GUEST_SCOPES and cannot
// mint keys, manage webhooks, or touch credentials. The identity exists so
// the guest key is bound to something attributable; the agent acts with the
// guest token. There is deliberately no way to recover the identity
// credential from this route — it is shown nowhere, stored hash-only.
//
// Guest tier, by construction:
// - The identity has no room memberships, so it holds no room capabilities.
//   manage_members / decide are unreachable: they require membership +
//   ownership, which this route never grants.
// - The guest key carries only ENROLL_GUEST_SCOPES (presence reporting +
//   reading presence + publishing its own signed directory card). It cannot
//   mint keys, manage webhooks, or touch credentials.
// - Acting on a starter task (claim/submit) uses the normal invite/join or
//   access-request flow named in the response's `next` steps.
// - An optional roomId files an access request inline
//   (server/access-requests.mjs): rooms with an auto-approve rule admit the
//   enrollment synchronously and the response carries the membership;
//   otherwise the request pends for the owner queue and the response says
//   how to poll it.
//
// Name-squatting guard: the registered lane names from lanes/REGISTRY.md are
// reserved (case-insensitive). An enrollment attempt as "quill" is rejected
// with 409 and a suggested alternative.
//
// Idempotency: the route keeps a caller-owned enrollment registry
// (name -> record, requestId -> record). A repeat call with the same
// requestId, or the same canonical display name, returns the existing
// enrollment WITHOUT re-issuing secrets. The registry is process-local in
// the default wiring; a persistent table is a later slice (it would need
// writer-fence registration, which is out of scope for this module).
//
// WIRING (deferred — the mount files are under live claims):
//   server/http.mjs:
//     import { createAgentEnrollRoutes } from "./agent-enroll.mjs";
//     import { AccessRequests } from "./access-requests.mjs";
//     const accessRequests = new AccessRequests(store); // or reuse the http.mjs instance
//     const agentEnroll = createAgentEnrollRoutes({ store, json, reject, body, rate, exact, origin, accessRequests });
//     // before the /api/ 404 guard, next to the agentPlugin mount:
//     if (await agentEnroll(req, res, { url, remoteAddress })) return;
//   scripts/runtime-package.mjs: register server/agent-enroll.mjs (exact
//     allowlist — the browser gate fails closed without it).
//   docs/openapi.yaml: add the POST /api/agents/enroll fragment.
//   docs/SWARM-PLUG-IN.md: add the one-command curl section.
//
// Collision note (2026-09-29): server/http.mjs is held by jillianai
// (RC-2026-09-28-2870/2872/2878/2880), scripts/runtime-package.mjs by jill
// (RC-2026-09-28-2873), docs/SWARM-PLUG-IN.md + server/agent-plugin-routes.mjs
// by jill (RC-2026-09-28-3602), docs/openapi.yaml by jillianai
// (RC-2026-09-28-2870/2871). This module touches none of them: it is a new
// file with the same (req, res, ctx) -> boolean handler contract as
// createAgentPluginRoutes, so the wiring is mechanical once claims clear.
import { createHash } from "node:crypto";
import { AccessRequests } from "./access-requests.mjs";
import { buildOpportunitiesFeed } from "./opportunities.mjs";

const ENROLL_PATH = "/api/agents/enroll";

// Guest-safe subset of the documented rak_ scope vocabulary
// (server/agent-api-keys.mjs API_KEY_SCOPES). Presence + self-attested
// discovery only: nothing here mints keys, manages webhooks, or reads
// another identity's data.
export const ENROLL_GUEST_SCOPES = Object.freeze([
  "heartbeats:report",
  "heartbeats:read",
  "directory:publish",
]);

export const ENROLL_GUEST_TTL_MS = 24 * 3600 * 1000;
export const ENROLL_STARTER_TASKS = 3;
export const ENROLL_PER_MINUTE = 10;

// Registered lane names (lanes/REGISTRY.md): an outside agent must not enroll
// as "quill" — first-come name-squatting on a known lane. Compared
// case-insensitively; a reserved name is rejected with 409 and a suggested
// alternative. tests/agent-enroll.test.js asserts this list stays in sync
// with the registry table.
export const RESERVED_LANE_NAMES = Object.freeze(
  ["quill", "quill-s2", "instinct", "grokbot", "codex", "Jillian"]);

// The permission set an inline roomId access request asks for: the standard
// guest-worker grant. Rooms whose auto-approve rule covers it admit the
// enrollment synchronously; anything else pends for the owner queue.
export const ENROLL_ROOM_PERMISSIONS = Object.freeze(["accept_work", "complete_work"]);

const NAME_MAX = 80;
const CONTACT_MAX = 200;
const REQUEST_ID_MAX = 128;

// Same canonicalization as server/agent-identities.mjs create(): names that
// differ only by case/whitespace are the same enrollment.
const canonicalName = value => value.trim().replace(/\p{White_Space}+/gu, " ").toLowerCase();

const check = (condition, message) => { if (!condition) throw new Error(message); };

const isServiceError = error => !!error && typeof error.status === "number" && typeof error.code === "string";

const starterTaskView = (item, origin) => {
  if (item.kind === "bounty") {
    return Object.freeze({
      kind: "bounty",
      id: item.bountyId,
      title: item.title,
      roomId: item.roomId,
      roomTitle: item.roomTitle,
      roomUrl: `${origin}${item.roomPath}`,
      criteria: item.criteria ?? null,
      amountMillis: item.amountMillis ?? null,
      state: item.state,
      deadlineMs: item.deadlineMs ?? null,
    });
  }
  return Object.freeze({
    kind: "help-wanted",
    id: item.workItemId,
    title: item.title,
    roomId: item.roomId,
    roomTitle: item.roomTitle,
    roomUrl: `${origin}${item.roomPath}`,
    definitionOfDone: item.definitionOfDone ?? null,
    helpScope: item.helpScope ?? null,
    workState: item.workState,
  });
};

export function createAgentEnrollRoutes({
  store, json, reject, body, rate, exact, origin,
  now = () => Date.now(),
  enrollments = new Map(),
  buildFeed = buildOpportunitiesFeed,
  enrollPerMinute = ENROLL_PER_MINUTE,
  guestTtlMs = ENROLL_GUEST_TTL_MS,
  starterTaskLimit = ENROLL_STARTER_TASKS,
  // Filed when the caller passes roomId (server/access-requests.mjs).
  // Defaults to a fresh instance on the same store; injectable for tests.
  accessRequests = null,
} = {}) {
  check(store && typeof store === "object", "store is required");
  check(typeof json === "function", "json is required");
  check(typeof reject === "function", "reject is required");
  check(typeof body === "function", "body is required");
  check(typeof rate === "function", "rate is required");
  check(typeof exact === "function", "exact is required");
  check(typeof origin === "string" && origin.length > 0, "origin is required");
  check(enrollments instanceof Map, "enrollments must be a Map");
  check(typeof buildFeed === "function", "buildFeed is required");

  const translate = handler => async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      // Store-layer failures already carry HTTP status/code (ServiceError);
      // surface them unchanged instead of 500ing.
      if (isServiceError(error)) reject(error.status, error.code, error.message);
      throw error;
    }
  };

  const recordEnrollment = ({ name, contact, requestId, identityId, keyId, createdAt }) => {
    const record = Object.freeze({ name, contact: contact ?? null, requestId: requestId ?? null, identityId, keyId, createdAt });
    enrollments.set(`name:${canonicalName(name)}`, record);
    if (requestId) enrollments.set(`request:${requestId}`, record);
    return record;
  };

  const findEnrollment = ({ name, requestId }) => {
    if (requestId) {
      const hit = enrollments.get(`request:${requestId}`);
      if (hit) return hit;
    }
    return enrollments.get(`name:${canonicalName(name)}`) ?? null;
  };

  const discovery = () => Object.freeze({
    agentCard: `${origin}/.well-known/agent-card.json`,
    agentJson: `${origin}/.well-known/agent.json`,
    llmsTxt: `${origin}/llms.txt`,
    opportunities: `${origin}/api/opportunities.json`,
    plugInGuide: "https://github.com/Uuriko/project-room/blob/main/docs/SWARM-PLUG-IN.md",
  });

  const nextSteps = () => Object.freeze([
    Object.freeze({
      action: "request-room-access",
      method: "POST",
      path: "/api/access-requests",
      description: "Ask to join a room: send { roomId, identityId, displayName, requestedPermissions }. Rooms with auto-approve admit you synchronously; otherwise poll the returned status path.",
    }),
    Object.freeze({
      action: "poll-opportunities",
      method: "GET",
      path: "/api/opportunities.json",
      description: "Poll the public board for open work. Acting on an item uses the normal invite/join flow.",
    }),
    Object.freeze({
      action: "read-plug-in-guide",
      method: "GET",
      path: "https://github.com/Uuriko/project-room/blob/main/docs/SWARM-PLUG-IN.md",
      description: "The full agent plug-in guide: MCP route, Node client, claim grammar, write loop.",
    }),
  ]);

  const publicSummary = (record, { duplicate, roomJoin = null }) => {
    let starterTasks = [];
    try {
      const feed = buildFeed(store, { now: now(), limit: starterTaskLimit });
      starterTasks = (feed?.opportunities ?? []).slice(0, starterTaskLimit).map(item => starterTaskView(item, origin));
    } catch {
      // The feed is a courtesy, not the enrollment: a feed failure must not
      // fail enrollment. The discovery URL still lets the agent poll it.
      starterTasks = [];
    }
    return {
      type: "agent_enrollment",
      duplicate,
      identityId: record.identityId,
      displayName: record.name,
      contact: record.contact,
      // No identity credential is ever issued here (red-team HIGH,
      // RC-2026-09-29-3604): the guest token below is the only usable
      // credential in the response. There is no `credential` field at all —
      // not even null — so no client can mistake this route for an issuance
      // route.
      guestToken: null,
      guestTokenScopes: [...ENROLL_GUEST_SCOPES],
      roomJoin,
      discovery: discovery(),
      starterTasks: Object.freeze(starterTasks),
      tier: "guest",
      tierNote: "Guest tier: no room memberships, no merge rights, no credential access. The guest token carries presence + self-published directory scopes only and expires.",
      next: nextSteps(),
    };
  };

  // Inline room join for the optional roomId: files an access request for the
  // guest-worker permission set. The request id is derived deterministically
  // from (roomId, enroll requestId-or-identity), so a retried enrollment maps
  // to the same request instead of spamming the owner queue.
  const fileRoomJoin = ({ roomId, identityId, displayName, enrollRequestId }) => {
    const requests = accessRequests ?? new AccessRequests(store);
    const joinRequestId = `are_${createHash("sha256").update(`${roomId}:${enrollRequestId ?? identityId}`).digest("hex").slice(0, 24)}`;
    const filed = requests.request(roomId, {
      identityId,
      displayName,
      requestedPermissions: [...ENROLL_ROOM_PERMISSIONS],
      note: "one-call guest enrollment",
      requestId: joinRequestId,
    });
    if (filed.status === "approved") {
      return Object.freeze({
        roomId,
        requestId: filed.requestId,
        status: "approved",
        memberId: filed.memberId ?? null,
        grantedPermissions: Object.freeze([...(filed.grantedPermissions ?? [])]),
      });
    }
    return Object.freeze({
      roomId,
      requestId: filed.requestId,
      status: filed.status,
      pendingNote: filed.pendingNote ?? null,
      pollPath: `/api/access-requests/${encodeURIComponent(filed.requestId)}?identityId=${encodeURIComponent(identityId)}`,
    });
  };

  const enroll = translate(async (req, res, { remoteAddress, url }) => {
    // Abuse control (John's standing rule): per-address per-minute budget,
    // same family pattern as the other unauthenticated issuance routes.
    rate(`agent-enroll:${remoteAddress}`, enrollPerMinute);

    const data = await body(req);
    const shape = data && (
      exact(data, ["name"]) || exact(data, ["name", "contact"]) ||
      exact(data, ["name", "requestId"]) || exact(data, ["name", "contact", "requestId"]) ||
      exact(data, ["name", "roomId"]) || exact(data, ["name", "contact", "roomId"]) ||
      exact(data, ["name", "requestId", "roomId"]) || exact(data, ["name", "contact", "requestId", "roomId"])
    );
    if (!shape) reject(422, "invalid_enrollment", "name, with optional contact, requestId, and roomId, are the accepted fields");
    if (typeof data.name !== "string" || !data.name.trim() || data.name.length > NAME_MAX)
      reject(422, "invalid_enrollment", "name must be a non-empty string of at most 80 characters");
    if (data.contact !== undefined && (typeof data.contact !== "string" || data.contact.length > CONTACT_MAX))
      reject(422, "invalid_enrollment", "contact must be a string of at most 200 characters when given");
    if (data.requestId !== undefined && (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > REQUEST_ID_MAX))
      reject(422, "invalid_enrollment", "requestId must be a non-empty string of at most 128 characters when given");
    if (data.roomId !== undefined && (typeof data.roomId !== "string" || !data.roomId || data.roomId.length > 384))
      reject(422, "invalid_enrollment", "roomId must be a non-empty string of at most 384 characters when given");

    const name = data.name.trim();
    // Name-squatting guard (RC-2026-09-29-3604): registered lane names are
    // reserved, case-insensitively. Rejected before the idempotency lookup so
    // a squat never even reads as an existing enrollment.
    const squatted = RESERVED_LANE_NAMES.find(lane => lane.toLowerCase() === canonicalName(name));
    if (squatted) {
      reject(409, "name_reserved",
        `Name "${name}" is reserved for a registered lane. Try "${name}-agent" instead.`);
    }
    const roomId = data.roomId ?? null;

    const existing = findEnrollment({ name, requestId: data.requestId });
    if (existing) {
      // Idempotent: no duplicate identity, no re-issued secrets. An inline
      // room join re-runs against the derived request id, so a retried call
      // maps to the same access request instead of filing a second one.
      const roomJoin = roomId
        ? fileRoomJoin({ roomId, identityId: existing.identityId, displayName: existing.name, enrollRequestId: data.requestId })
        : null;
      return json(res, 200, Object.freeze({ ...publicSummary(existing, { duplicate: true, roomJoin }) }));
    }

    // Same primitive as POST /api/agent-identities: bounded by the
    // IDENTITY_LIMIT table cap inside the insert transaction (409
    // pilot_limit, no row written). Control-char and deceptive-spelling
    // rules are enforced there too.
    const identity = store.identities.create(name);
    // The inline room join runs BEFORE the key is issued (H-23): the old
    // order committed the shown-once credential and *then* joined, so a
    // join failure left the key committed but never delivered — and the
    // retry path returns guestToken: null, losing the credential forever.
    // Join-first means a join failure fails the whole enrollment with no
    // credential minted, and the retry starts clean.
    const roomJoin = roomId
      ? fileRoomJoin({ roomId, identityId: identity.identityId, displayName: name, enrollRequestId: data.requestId })
      : null;
    const createdAt = now();
    const issued = store.agentPlugin.issueApiKey({
      identityId: identity.identityId,
      scopes: [...ENROLL_GUEST_SCOPES],
      expiresAt: createdAt + guestTtlMs,
      label: "one-call guest enrollment",
    });
    const record = recordEnrollment({
      name,
      contact: data.contact,
      requestId: data.requestId,
      identityId: identity.identityId,
      keyId: issued.keyId,
      createdAt,
    });

    const summary = publicSummary(record, { duplicate: false });
    return json(res, 201, Object.freeze({
      ...summary,
      roomJoin,
      guestToken: `rak_${issued.secret}`,
      guestTokenId: issued.keyId,
      guestTokenExpiresAt: issued.expiresAt,
      publicKey: identity.publicKey ?? null,
    }));
  });

  // Same (req, res, ctx) -> boolean contract as createAgentPluginRoutes:
  // true when this module served the request, false to fall through.
  return async function handleAgentEnrollRoutes(req, res, { url, remoteAddress }) {
    const pathname = url.pathname;
    if (pathname !== ENROLL_PATH) return false;
    if (req.method === "POST") {
      await enroll(req, res, { remoteAddress, url });
      return true;
    }
    reject(405, "method_not_allowed", "Method not allowed");
    return true; // unreachable — reject throws
  };
}
