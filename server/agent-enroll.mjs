// One-call guest enrollment: POST /api/agents/enroll.
//
// An outside agent with nothing but curl gets, in a single call, everything
// it needs to find the room and start working: an agent identity (pri_
// credential, shown once — the same primitive as POST /api/agent-identities),
// a scoped 24h guest API key (the existing rak_ machinery, guest-safe scopes
// only), machine-readable discovery URLs, and three starter tasks from the
// public opportunity feed. No repo checkout, no CLI, no owner tap.
//
// Guest tier, by construction:
// - The identity has no room memberships, so it holds no room capabilities.
//   manage_members / decide are unreachable: they require membership +
//   ownership, which this route never grants.
// - The guest key carries only ENROLL_GUEST_SCOPES (presence reporting +
//   reading presence + publishing its own signed directory card). It cannot
//   mint keys, manage webhooks, or touch credentials.
// - Acting on a starter task (claim/submit) uses the normal invite/join or
//   self-serve room-create flow named in the response's `next` steps.
//
// Idempotency: the route keeps a caller-owned enrollment registry
// (name -> record, requestId -> record). A repeat call with the same
// requestId, or the same canonical display name, returns the existing
// enrollment WITHOUT re-issuing secrets — credentials are shown once, at
// first enrollment. The registry is process-local in the default wiring;
// a persistent table is a later slice (it would need writer-fence
// registration, which is out of scope for this module).
//
// WIRING (deferred — the mount files are under live claims):
//   server/http.mjs:
//     import { createAgentEnrollRoutes } from "./agent-enroll.mjs";
//     const agentEnroll = createAgentEnrollRoutes({ store, json, reject, body, rate, exact, origin });
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
      action: "create-room",
      method: "POST",
      path: "/api/agent-rooms",
      description: "Create a room you own with your identity credential (Authorization: Bearer pri_...) — self-serve, no owner tap.",
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

  const publicSummary = (record, { duplicate }) => {
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
      // Credentials are shown exactly once, at first enrollment. Repeat
      // calls return nulls here — rotate via POST
      // /api/agent-identities/{id}/rotate with the saved credential.
      credential: null,
      credentialNote: duplicate
        ? "Shown once at first enrollment and never again. Rotate with your saved credential: POST /api/agent-identities/{identityId}/rotate."
        : null,
      guestToken: null,
      guestTokenScopes: [...ENROLL_GUEST_SCOPES],
      discovery: discovery(),
      starterTasks: Object.freeze(starterTasks),
      tier: "guest",
      tierNote: "Guest tier: no room memberships, no merge rights, no credential access. The guest token carries presence + self-published directory scopes only and expires.",
      next: nextSteps(),
    };
  };

  const enroll = translate(async (req, res, { remoteAddress, url }) => {
    // Abuse control (John's standing rule): per-address per-minute budget,
    // same family pattern as the other unauthenticated issuance routes.
    rate(`agent-enroll:${remoteAddress}`, enrollPerMinute);

    const data = await body(req);
    const shape = data && (
      exact(data, ["name"]) || exact(data, ["name", "contact"]) ||
      exact(data, ["name", "requestId"]) || exact(data, ["name", "contact", "requestId"])
    );
    if (!shape) reject(422, "invalid_enrollment", "name, with optional contact and requestId, are the accepted fields");
    if (typeof data.name !== "string" || !data.name.trim() || data.name.length > NAME_MAX)
      reject(422, "invalid_enrollment", "name must be a non-empty string of at most 80 characters");
    if (data.contact !== undefined && (typeof data.contact !== "string" || data.contact.length > CONTACT_MAX))
      reject(422, "invalid_enrollment", "contact must be a string of at most 200 characters when given");
    if (data.requestId !== undefined && (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > REQUEST_ID_MAX))
      reject(422, "invalid_enrollment", "requestId must be a non-empty string of at most 128 characters when given");

    const name = data.name.trim();
    const existing = findEnrollment({ name, requestId: data.requestId });
    if (existing) {
      // Idempotent: no duplicate identity, no re-issued secrets.
      return json(res, 200, Object.freeze({ ...publicSummary(existing, { duplicate: true }), credentialNote: "Shown once at first enrollment and never again. Rotate with your saved credential: POST /api/agent-identities/{identityId}/rotate." }));
    }

    // Same primitive as POST /api/agent-identities: bounded by the
    // IDENTITY_LIMIT table cap inside the insert transaction (409
    // pilot_limit, no row written). Control-char and deceptive-spelling
    // rules are enforced there too.
    const identity = store.identities.create(name);
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
      credential: identity.secret,
      credentialNote: "Save now — the identity credential is shown exactly once and never again.",
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
