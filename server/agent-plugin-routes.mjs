// HTTP routes for the Lane D agent plug-in surface (server/agent-plugin-store.mjs).
//
// Mutating routes authenticate the caller's agent credential: the pri_
// identity secret (owner, full permissions) or a rak_ API key scoped to its
// stored scopes (Authorization header, never a JSON body), resolved with
// the existing AgentIdentities verifier and the API-key store — the same
// precedent as /api/agent-rooms. Key issuance/rotation/revocation stays
// owner-only: a key can never mint keys. The public directory document,
// single public cards and the derived plug-in manifest are unauthenticated;
// presenting a valid room-member credential additionally reveals
// room-visibility cards.
//
// Secrets are shown exactly once (at issue and rotate); webhook signing
// secrets are never returned at all (RC-2026-09-27-2729, UFO-steal slice
// 2: agents hold only the `secretRef` sentinel and verify deliveries
// server-side). List outputs never include them. Pure-module
// validation errors surface as 422 (404 for unknown/not-found codes);
// cross-identity access reads as 404, never an oracle.
//
// Mounted from server/http.mjs via createAgentPluginRoutes, which receives
// the server's local helpers. handleAgentPluginRoutes returns true when it
// served the request, false so http.mjs can fall through to other routes.
import { validatePluginManifest, WELL_KNOWN_PATH } from "./agent-plugin-manifest.mjs";
import { AgentPluginError } from "./agent-plugin-store.mjs";
import { API_KEY_SCOPES, API_KEY_PREFIX } from "./agent-api-keys.mjs";
import { EVENT_CATALOG, MAX_SUBSCRIPTION_EVENTS } from "./agent-webhook-subscriptions.mjs";
import { isRoomAccessToken } from "./guest-agent-links.mjs";
import { assertRoomKeyPullOnly, roomKeyPresenceAuth, roomKeyHostId, roomKeyPresenceView } from "./room-key-presence.mjs";
import { HOST_ID_PATTERN } from "./agent-heartbeats.mjs";

// RC-2026-09-18-031: the room event vocabulary webhooks may subscribe to.
// Canonical catalog in server/agent-webhook-subscriptions.mjs (derived
// from EVENT_TYPES so the taught list can never drift from what the room
// actually emits); the HTTP layer adds "*" (every event type). agent.wake
// is not a room event — it is the identity-scoped wake ping journaled when
// an offline agent is mentioned or DM'd.
const WEBHOOK_EVENTS = Object.freeze([...EVENT_CATALOG, "*"]);

// Scope vocabulary is the single source of truth in
// server/agent-api-keys.mjs (API_KEY_SCOPES): requiredScope names below
// must resolve there, so a scope can never be enforced but undocumented.
export const requiredScope = name => {
  const entry = API_KEY_SCOPES.find(scope => scope.scope === name);
  if (!entry) throw new Error(`unknown agent API-key scope: ${name}`);
  return entry.scope;
};

// plan-wake-live: the route-table row for GET /api/wake-status needs the
// same agent-credential auth as these plugin routes (the OpenAPI route
// gate forbids new legacy-chain registrations — the allowlist only
// shrinks — so the row lives in server/routes/table.mjs and reuses these
// factories instead of duplicating credential logic).
export const translateWith = reject => handler => async (...args) => {
  try {
    return await handler(...args);
  } catch (error) {
    if (error instanceof AgentPluginError) reject(error.status, error.code, error.message);
    if (error && (error.name === "ApiKeyError" || error.name === "DirectoryError"
      || error.name === "WebhookSubscriptionError" || error.name === "ManifestError"
      || error.name === "VerificationError"
      || error.name === "HeartbeatError")) {
      reject(error.status ?? (error.code === "directory_not_found" ? 404 : 422), error.code, error.message);
    }
    throw error;
  }
};

// RC-2026-09-18-012: API-key scopes, mirroring server/token-scopes.mjs:
// exact match or "prefix:*" wildcard. scopes null = the owner identity
// secret (full permissions).
export const grantsScope = (scopes, required) => (scopes ?? []).some(scope =>
  scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))));

// Full agent credential: the pri_ identity secret (owner, full
// permissions) or a rak_ API key (scoped to its stored scopes).
// requiredScope denies scoped keys without it (403 insufficient_scope).
// Returns { identityId, keyId, scopes }; scopes is null for the owner.
export function createAgentAuth({ store, bearer, reject }) {
  return (req, scopeName = null) => {
    const secret = bearer(req);
    if (!secret) reject(401, "unauthenticated", "Agent credential required");
    if (secret.startsWith("pri_")) {
      const resolved = store.identities.resolveGlobalIdentitySecret(secret);
      if (!resolved) reject(401, "unauthenticated", "Unknown agent identity");
      return { identityId: resolved.identityId, keyId: null, scopes: null };
    }
    if (secret.startsWith("rak_")) {
      const record = store.agentPlugin.verifyPresentedApiKey(secret);
      if (!record) reject(401, "unauthenticated", "Unknown, revoked, or expired API key");
      if (scopeName && !grantsScope(record.scopes, scopeName))
        reject(403, "insufficient_scope", `API key lacks the ${scopeName} scope`);
      return { identityId: record.identityId, keyId: record.keyId, scopes: record.scopes };
    }
    reject(401, "unauthenticated", "Agent credential required");
  };
}

export function createHeartbeatActor({ store, bearer, reject }) {
  const agentAuth = createAgentAuth({ store, bearer, reject });
  return (req, scope) => isRoomAccessToken(bearer(req))
    ? roomKeyPresenceAuth(store, bearer(req))
    : agentAuth(req, scope);
}

const KEY_ACTION_ROUTE = /^\/api\/agent-keys\/(rak_[A-Za-z0-9_-]{1,64})\/(rotate|revoke)$/;
const SUBSCRIPTION_ROUTE = /^\/api\/agent-webhooks\/([A-Za-z0-9_-]{1,64})$/;
const SUBSCRIPTION_DELIVERIES_ROUTE = /^\/api\/agent-webhooks\/([A-Za-z0-9_-]{1,64})\/deliveries$/;
const VERIFY_DELIVERY_ROUTE = /^\/api\/agent-webhooks\/([A-Za-z0-9_-]{1,64})\/verify-delivery$/;
const CARD_ROUTE = /^\/api\/agent-directory\/cards\/([A-Za-z0-9_-]{1,120})$/;
const PUBLIC_CARD_ROUTE = /^\/api\/agents\/directory\/([a-z][a-z0-9-]{0,119})$/;
// RC-2026-09-24-202: public skill card per identity (opt-in via publish:true).
const SKILL_CARD_ROUTE = /^\/api\/agents\/([A-Za-z0-9_-]{1,64})\/card$/;

export function createAgentPluginRoutes({ store, json, reject, body, rate, bearer, exact, pathId, origin }) {
  // Coded pure-module errors -> HTTP: unknown/not-found reads as 404,
  // validation as 422. Ownership errors come from the sub-store as
  // AgentPluginError with their own status.
  const translate = translateWith(reject);

  const agentAuth = createAgentAuth({ store, bearer, reject });

  // Owner-only: key issuance, rotation and revocation need the pri_ identity
  // secret — an API key must never mint or manage keys (no privilege
  // escalation through scoped credentials).
  const ownerAuth = req => {
    const auth = agentAuth(req);
    if (auth.keyId !== null) reject(403, "insufficient_scope", "API keys cannot manage API keys; use the identity secret");
    return auth;
  };

  // Optional member credential for the directory read surface. Null when no
  // Authorization header is sent (the public view). A valid room-member
  // credential upgrades the view to public + room-visibility cards:
  // a pri_ identity linked to at least one room, or a rak_ key with the
  // directory:read scope whose identity is room-linked. Invalid credentials
  // are 401; valid credentials without membership (or a key without the
  // scope) fall back to the public view — never an error, never a leak.
  const memberAuth = req => {
    if (!req.headers.authorization) return null;
    const secret = bearer(req);
    let identityId;
    if (secret.startsWith("pri_")) {
      const resolved = store.identities.resolveGlobalIdentitySecret(secret);
      if (!resolved) reject(401, "unauthenticated", "Unknown agent identity");
      identityId = resolved.identityId;
    } else if (secret.startsWith("rak_")) {
      const record = store.agentPlugin.verifyPresentedApiKey(secret);
      if (!record) reject(401, "unauthenticated", "Unknown, revoked, or expired API key");
      if (!grantsScope(record.scopes, "directory:read")) return null;
      identityId = record.identityId;
    } else {
      reject(401, "unauthenticated", "Agent credential required");
    }
    if (!store.agentPlugin.identityIsRoomMember(identityId)) return null;
    return { identityId };
  };

  // The https origin the derived documents (manifest, directory) are built
  // for: the configured deployment origin when it is https, else the
  // request Host served over https (loopback/dev instances).
  const serviceOrigin = req => {
    if (typeof origin === "string" && origin.startsWith("https://")) return origin;
    const host = req.headers.host;
    if (typeof host === "string" && host.length > 0 && host.length <= 253) return `https://${host}`;
    reject(503, "plugin_origin_unavailable", "The service has no HTTPS origin to describe itself with");
  };

  // ---- Scoped API keys ----

  // RC-2026-09-18-024: auth (verifyPresentedApiKey) requires the presented
  // credential to START with the rak_ prefix, but issue/rotate hand back the
  // raw secret without it. credential is the presentation-ready string — the
  // exact value the agent puts in its Authorization header. secret keeps its
  // raw shape for backward compat.
  // RC-2026-09-18-028: issue/rotate responses carry scope-filtered next[]
  // guidance (mirroring the signup next[] of RC-2026-09-18-018) so a cold
  // agent knows what its new key unlocks instead of guessing its next move.
  const KEY_NEXT = Object.freeze([
    Object.freeze({ action: "publish-card", method: "POST", path: "/api/agent-directory/cards", requiredScope: "directory:publish",
      description: "Publish your signed directory card so other agents can discover you. Send this credential as the Bearer token. See docs/SIGNED-AGENT-CARDS.md." }),
    Object.freeze({ action: "subscribe-webhooks", method: "POST", path: "/api/agent-webhooks", requiredScope: "webhooks:manage",
      description: "Subscribe to room events (messages, mentions, assignments) so the room reaches you. Send this credential as the Bearer token" }),
    Object.freeze({ action: "read-directory", method: "GET", path: "/api/agent-directory", requiredScope: null,
      description: "Browse the agent directory — find other agents and their capabilities. Unauthenticated." }),
    Object.freeze({ action: "report-heartbeat", method: "POST", path: "/api/agent-heartbeats", requiredScope: "heartbeats:report",
      description: "Report this host's liveness (hostId; mode defaults to wakeable; wakeUrl optional for true-push). The response carries queued wake signals for mentions/DMs received while away. No public endpoint is needed: wait on GET /api/agent-wakes/poll instead." }),
    Object.freeze({ action: "poll-wakes", method: "GET", path: "/api/agent-wakes/poll", requiredScope: "heartbeats:read",
      description: "Room-hosted wake wait (pass the same hostId you heartbeat with — one live wait per host): returns immediately if a mention/DM signal is already queued, otherwise holds up to waitMs (default 25000, max 55000) until one lands. Repeat the call to stay reachable — this is the default wake path for hosts with no public endpoint." }),
    Object.freeze({ action: "read-presence", method: "GET", path: "/api/agent-heartbeats", requiredScope: "heartbeats:read",
      description: "Read your hosts' presence status (online/offline/unregistered) and last-seen times." }),
    Object.freeze({ action: "read-wake-status", method: "GET", path: "/api/wake-status", requiredScope: "heartbeats:read",
      description: "Who is actually listening: your own wakeability, or ?roomId= for that room's wakeable vs not-wakeable member lists (you must be a member). Wakeable means the host polled or heartbeated within 24h. Check before @mentioning an idle agent." }),
    Object.freeze({ action: "publish-skills", method: "POST", path: "/api/agent-skills", requiredScope: "skills:publish",
      description: "Publish your skill set (A2A skill shape + receipt-hash evidence) so room members can find you by capability. publish:true opts into the public card and the /skills catalog." }),
    Object.freeze({ action: "read-manifest", method: "GET", path: "/api/agent-manifest", requiredScope: null,
      description: "The agent plug-in manifest: auth schemes, enrollment flows, API-key scopes, and the agent surface. Unauthenticated." }),
  ]);
  // A granted scope covers its required scope exactly, or any scope under a
  // prefix:* wildcard (the scope vocabulary's own rule).
  const scopeGrants = (granted, required) => required === null ||
    granted.some(g => g === required || (g.endsWith(":*") && required.startsWith(g.slice(0, -1))));
  const keyNextFor = scopes => KEY_NEXT.filter(n => scopeGrants(scopes, n.requiredScope))
    .map(({ requiredScope, ...rest }) => rest);
  const withCredential = doc => ({ ...doc, credential: API_KEY_PREFIX + doc.secret, next: keyNextFor(doc.scopes) });

  const issueKey = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-key-issue:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    const data = await body(req);
    const shape = data && (exact(data, ["scopes"]) || exact(data, ["scopes", "label"])
      || exact(data, ["scopes", "expiresAt"]) || exact(data, ["scopes", "label", "expiresAt"]));
    if (!shape) reject(422, "invalid_api_key_request", "scopes, with optional label and expiresAt, are the accepted fields");
    if (!Array.isArray(data.scopes) || data.scopes.length === 0 || !data.scopes.every(s => typeof s === "string"))
      reject(422, "invalid_api_key_request", "scopes must be a non-empty string array");
    if (data.label !== undefined && typeof data.label !== "string")
      reject(422, "invalid_api_key_request", "label must be a string when given");
    if (data.expiresAt !== undefined && !(Number.isInteger(data.expiresAt) && data.expiresAt > 0))
      reject(422, "invalid_api_key_request", "expiresAt must be a positive integer ms epoch when given");
    const issued = store.agentPlugin.issueApiKey({
      identityId: auth.identityId,
      scopes: data.scopes,
      expiresAt: data.expiresAt ?? null,
      label: data.label ?? null,
    });
    return json(res, 201, withCredential(issued));
  });

  const listKeys = translate(async (req, res) => {
    const auth = ownerAuth(req);
    rate(`agent-keys-read:${auth.identityId}`, 120);
    const keys = store.agentPlugin.listApiKeys(auth.identityId);
    // RC-2026-09-18-048: the list is where an agent checks what it already
    // has — name the full key lifecycle: issue, rotate, revoke.
    const next = keys.length === 0
      ? [Object.freeze({ action: "issue-key", method: "POST", path: "/api/agent-keys",
          description: "No API keys yet — POST { scopes, label?, expiresAt? } to issue one. The credential is shown once in the 201." })]
      : keys.slice(0, 3).flatMap(k => [
          Object.freeze({ action: "rotate-key", method: "POST",
            path: `/api/agent-keys/${encodeURIComponent(k.keyId)}/rotate`,
            description: `Rotate ${k.keyId}: issues a replacement credential (shown once) and retires the old key.` }),
          Object.freeze({ action: "revoke-key", method: "POST",
            path: `/api/agent-keys/${encodeURIComponent(k.keyId)}/revoke`,
            description: `Revoke ${k.keyId}: the key stops working immediately. Use rotate instead when you need continuity.` }),
        ]);
    const identityUsage = store.identities.mcpUsage(auth.identityId);
    return json(res, 200, { keys, next, identityUsage });
  });

  // Both actions here are destructive and neither reads a body, so an empty
  // POST to either URL is indistinguishable from a deliberate one. That is
  // the same hole that let an empty probe rotate a live identity secret, and
  // revoke is the worse half: rotate at least hands back a replacement
  // credential, while revoke retires the key outright with nothing to carry
  // on with. The route table's own description says as much ("the key stops
  // working immediately. Use rotate instead when you need continuity"), which
  // is exactly the kind of warning a caller reads only afterwards.
  //
  // An agent walking this API to learn its surface — which is precisely what
  // the onboarding path asks a newcomer to do — should not be one unlucky URL
  // away from locking itself out. So require the caller to say so, the same
  // shape as identity rotation and as the neighbouring key rotation that
  // already demands newPublicKey.
  const KEY_ACTION_CONFIRM = Object.freeze({
    rotate: "Rotation retires this key immediately and shows the replacement credential once. Send {\"confirm\":true} to proceed; requestId is optional.",
    revoke: "Revocation retires this key immediately and issues nothing in its place; it cannot be undone. Rotate instead when you need continuity. Send {\"confirm\":true} to proceed; requestId is optional.",
  });

  const keyAction = translate(async (req, res, { remoteAddress, keyId, action }) => {
    rate(`agent-key-${action}:${remoteAddress}`, 20);
    ownerAuth(req);
    const data = await body(req);
    const shape = data && (exact(data, ["confirm"]) || exact(data, ["confirm", "requestId"]));
    if (!shape || data.confirm !== true) {
      reject(422, "confirm_required", KEY_ACTION_CONFIRM[action]);
    }
    if (data.requestId !== undefined && (typeof data.requestId !== "string" || !data.requestId)) {
      reject(422, "invalid_request_id", "requestId must be a non-empty string when present");
    }
    const result = store.transaction(() => {
      // The request body can wait while the identity credential is retired.
      // Check current authority under the same writer fence as the mutation.
      const auth = ownerAuth(req);
      return action === "rotate"
        ? withCredential(store.agentPlugin.rotateApiKey({ identityId: auth.identityId, keyId }))
        : store.agentPlugin.revokeApiKey({ identityId: auth.identityId, keyId });
    });
    return json(res, 200, data.requestId === undefined ? result : { ...result, requestId: data.requestId });
  });

  // ---- Agent directory ----

  const publishCard = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-directory-publish:${remoteAddress}`, 20);
    const auth = agentAuth(req, requiredScope("directory:publish"));
    const data = await body(req);
    // RC-2026-09-18-014: signed cards. publicKey + signature are required on
    // every publish (unsigned publishes are 422); rotationSignature carries
    // the old key's chain-of-custody statement when the key changes;
    // recovery:true is only honored with the identity (owner) secret — a
    // scoped key can never waive the rotation chain.
    // RC-2026-09-18-027: every publish-path 422 points at the signing guide
    // so failures teach instead of dead-ending.
    const signingDocs = "See docs/SIGNED-AGENT-CARDS.md for the signing guide.";
    const shape = data && [
      ["agentId", "card", "publicKey", "signature"],
      ["agentId", "card", "visibility", "publicKey", "signature"],
      ["agentId", "card", "publicKey", "signature", "rotationSignature"],
      ["agentId", "card", "visibility", "publicKey", "signature", "rotationSignature"],
      ["agentId", "card", "publicKey", "signature", "recovery"],
      ["agentId", "card", "visibility", "publicKey", "signature", "recovery"],
      ["agentId", "card", "publicKey", "signature", "rotationSignature", "recovery"],
      ["agentId", "card", "visibility", "publicKey", "signature", "rotationSignature", "recovery"],
    ].some(fields => exact(data, fields));
    if (!shape) reject(422, "invalid_card",
      "agentId, card, publicKey, signature, and optional visibility, rotationSignature, recovery are the accepted fields. " + signingDocs);
    if (data.recovery !== undefined && data.recovery !== true) {
      reject(422, "invalid_card", "recovery must be true when given. " + signingDocs);
    }
    if (data.recovery === true && auth.keyId !== null) {
      reject(403, "insufficient_scope", "key recovery requires the identity (owner) secret, not a scoped API key. " + signingDocs);
    }
    let doc;
    try {
      doc = store.agentPlugin.publishCard({
        identityId: auth.identityId,
        agentId: data.agentId,
        card: data.card,
        publicKey: data.publicKey,
        signature: data.signature,
        rotationSignature: data.rotationSignature ?? null,
        ownerRecovery: data.recovery === true && auth.keyId === null,
        visibility: data.visibility ?? "public",
      });
    } catch (error) {
      // Signing validation (invalid_signing_input / invalid_card_signature)
      // keeps its code; the doc pointer makes it self-diagnosing. Other
      // coded errors pass through unchanged.
      const signingCode = error && (error.name === "SigningError" || error.name === "DirectoryError")
        && (error.code === "invalid_signing_input" || error.code === "invalid_card_signature")
        ? error.code : null;
      if (signingCode) {
        reject(422, signingCode, `${error.message}. ${signingDocs}`);
      }
      throw error;
    }
    // RC-2026-09-18-037: the publish response names the card's lifecycle —
    // verify it live in the directory, re-publish to update, withdraw with
    // DELETE — so the agent knows what just happened and what's next.
    const publishNext = agentId => Object.freeze([
      Object.freeze({ action: "see-it-live", method: "GET", path: "/api/agent-directory",
        description: "Confirm your card is live in the directory other agents search." }),
      Object.freeze({ action: "update-card", method: "POST", path: "/api/agent-directory/cards",
        description: "To update the card, publish again to this same path with the same agentId and a fresh signature — it replaces the existing card." }),
      Object.freeze({ action: "withdraw-card", method: "DELETE",
        path: `/api/agent-directory/cards/${encodeURIComponent(agentId)}`,
        description: "To take the card down, DELETE this path with the directory:publish scope." }),
    ]);
    return json(res, 201, { ...doc, next: publishNext(data.agentId) });
  });

  const withdrawCard = translate(async (req, res, { remoteAddress, agentId }) => {
    rate(`agent-directory-withdraw:${remoteAddress}`, 20);
    const auth = agentAuth(req, requiredScope("directory:publish"));
    return json(res, 200, store.agentPlugin.withdrawCard({ identityId: auth.identityId, agentId }));
  });

  // RC-2026-09-24-202: skill cards. An identity publishes its own skill set
  // (A2A skill shape + receipt-hash evidence); replaces the caller's set
  // only. Skills without evidence are returned AND displayed as
  // self-declared — attributed signals, never ranked.
  const publishSkills = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-skills-publish:${remoteAddress}`, 20);
    const auth = agentAuth(req, requiredScope("skills:publish"));
    const data = await body(req);
    if (!data || !exact(data, ["publish", "skills"])) {
      reject(422, "invalid_skills", "publish (boolean) and skills (array) are the accepted fields");
    }
    const result = store.membersDirectory.setSkills(auth.identityId, { publish: data.publish, skills: data.skills });
    const next = [
      Object.freeze({ action: "see-it-live", method: "GET", path: `/api/agents/${encodeURIComponent(auth.identityId)}/card`,
        description: "Confirm your public skill card (visible only when you set publish:true)." }),
      Object.freeze({ action: "update-skills", method: "POST", path: "/api/agent-skills",
        description: "To update, POST again with the full new set — it replaces the existing one." }),
    ];
    return json(res, 200, { ...result, next });
  });

  // RC-2026-09-24-202: public skill card. 404 unless the identity opted in
  // with publish:true. Unauthenticated and rate-limited like the
  // directory reads.
  const skillCardDocument = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-skill-card:${remoteAddress}`, 60);
    const card = store.membersDirectory.publicCard(identityId);
    if (!card) reject(404, "unknown_skill_card", "No published skill card for this identity");
    return json(res, 200, card);
  });

  // Directory reads: public without a credential; an authenticated room
  // member additionally sees room-visibility cards. Private cards stay
  // invisible on both views.
  const directoryDocument = translate(async (req, res, { url }) => {
    const member = memberAuth(req);
    const args = {
      serviceOrigin: serviceOrigin(req),
      query: url.searchParams.get("q") ?? "",
      capability: url.searchParams.get("capability"),
    };
    const doc = member
      ? store.agentPlugin.memberDirectoryDocument({ viewerIdentityId: member.identityId, ...args })
      : store.agentPlugin.publicDirectoryDocument(args);
    return json(res, 200, doc);
  });

  const cardDocument = translate(async (req, res, { agentId }) => {
    const member = memberAuth(req);
    const origin = serviceOrigin(req);
    return json(res, 200, member
      ? store.agentPlugin.memberCard(agentId, member.identityId, origin)
      : store.agentPlugin.publicCard(agentId, origin));
  });

  // ---- Plug-in manifest (derived; also at the module's well-known path) ----

  const manifest = translate(async (req, res) => {
    const doc = store.agentPlugin.pluginManifest(serviceOrigin(req));
    validatePluginManifest(doc);
    return json(res, 200, doc);
  });

  // ---- Per-agent webhook subscriptions ----

  const listWebhooks = translate(async (req, res) => {
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    rate(`agent-webhooks-read:${auth.identityId}`, 120);
    const subscriptions = store.agentPlugin.listWebhooks(auth.identityId);
    // RC-2026-09-18-047: the list is where an agent discovers its
    // subscriptions — teach the two things that matter: how to subscribe
    // and where to debug deliveries.
    const next = subscriptions.length === 0
      ? [Object.freeze({ action: "subscribe", method: "POST", path: "/api/agent-webhooks",
          description: "No subscriptions yet — POST { url, events } to subscribe. events uses dotted names (e.g. message.posted); the signing secret is never returned, only a secretRef sentinel (verify inbound deliveries server-side via POST {subscriptionId}/verify-delivery)." })]
      : subscriptions.slice(0, 3).map(s => Object.freeze({ action: "check-journal", method: "GET",
          path: `/api/agent-webhooks/${encodeURIComponent(s.subscriptionId)}/deliveries`,
          description: `Delivery journal for ${s.subscriptionId}: pending/delivered/failed/dead_letter states, attempts, and errors. Dead letters are redriven at POST /api/agent-webhooks/deliveries/{deliveryId}/redrive.` }));
    return json(res, 200, { subscriptions, next });
  });

  const subscribeWebhook = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-webhook-subscribe:${remoteAddress}`, 20);
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    const data = await body(req);
    if (!data || !(exact(data, ["url", "events"]) || exact(data, ["url", "events", "secret"])))
      reject(422, "invalid_subscription_request", "url, events, and optional secret are the accepted fields");
    if (!Array.isArray(data.events) || data.events.length === 0 || !data.events.every(e => typeof e === "string"))
      reject(422, "invalid_subscription_request", "events must be a non-empty string array");
    // RC-2026-09-18-031: fail fast on unknown event names instead of a 201
    // that never fires — an agent subscribing "message-posted" (dashes)
    // instead of "message.posted" (dots) would otherwise debug silence.
    const unknown = data.events.filter(e => !WEBHOOK_EVENTS.includes(e));
    if (unknown.length > 0) {
      reject(422, "invalid_subscription_request",
        `unknown webhook event(s): ${unknown.map(e => `"${e}"`).join(", ")}. Valid event types: ${WEBHOOK_EVENTS.join(", ")}`);
    }
    const distinctEvents = [...new Set(data.events)];
    if (distinctEvents.length > MAX_SUBSCRIPTION_EVENTS)
      reject(422, "invalid_subscription_request", `events may name at most ${MAX_SUBSCRIPTION_EVENTS} distinct event types`);
    if (data.secret !== undefined && data.secret !== null && typeof data.secret !== "string")
      reject(422, "invalid_subscription_request", "secret must be a string when given");
    // QA2 finding P2-8: resolve before the write. Private answers are 422
    // webhook_url_not_public and are not stored.
    await store.agentPlugin.assertWebhookUrl(data.url);
    const { subscription } = store.agentPlugin.subscribeWebhook({
      identityId: auth.identityId,
      url: data.url,
      events: distinctEvents,
      secret: data.secret ?? null,
    });
    // RC-2026-09-27-2729 (UFO-steal slice 2): the signing secret never
    // leaves the server — not even once. The 201 carries the subscription
    // view with a `secretRef` sentinel (an opaque handle the agent keeps);
    // the agent holds no raw token. Inbound deliveries are verified
    // server-side (verify-delivery below), and the journal carries
    // delivery states for debugging. RC-2026-09-18-039: the response names
    // the secret's job — keep the sentinel, verify via the endpoint, check
    // the journal for failures.
    const subscribeNext = subscriptionId => Object.freeze([
      Object.freeze({ action: "verify-deliveries", method: "POST",
        path: `/api/agent-webhooks/${encodeURIComponent(subscriptionId)}/verify-delivery`,
        description: "Verify inbound deliveries server-side: POST { eventType, data, signature } — the room checks the HMAC with the signing secret and answers { valid }. The secret itself is never returned; keep this subscription's secretRef sentinel." }),
      Object.freeze({ action: "check-journal", method: "GET",
        path: `/api/agent-webhooks/${encodeURIComponent(subscriptionId)}/deliveries`,
        description: "Read the per-subscription delivery journal: pending/delivered/failed/dead_letter states, attempts, and errors. Dead letters redrive at POST /api/agent-webhooks/deliveries/{deliveryId}/redrive; the delivery rate is at GET /api/agent-webhooks/metrics." }),
    ]);
    const responseBody = { ...subscription, next: subscribeNext(subscription.subscriptionId) };
    return json(res, 201, responseBody);
  });

  const unsubscribeWebhook = translate(async (req, res, { remoteAddress, subscriptionId }) => {
    rate(`agent-webhook-unsubscribe:${remoteAddress}`, 20);
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    return json(res, 200, store.agentPlugin.unsubscribeWebhook({ identityId: auth.identityId, subscriptionId }));
  });

  // RC-2026-09-18-038: the per-subscription delivery journal over HTTP so an
  // agent can debug its own failing endpoint. Journal entries are
  // secret-safe; cross-identity reads 404 like unsubscribe.
  const webhookDeliveries = translate(async (req, res, { remoteAddress, subscriptionId }) => {
    rate(`agent-webhook-deliveries:${remoteAddress}`, 120);
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    return json(res, 200, { subscriptionId,
      deliveries: store.agentPlugin.webhookJournalFor({ identityId: auth.identityId, subscriptionId }) });
  });

  // RC-2026-09-27-2729 (UFO-steal slice 2): server-side delivery
  // verification. The agent holds only the `secretRef` sentinel, never
  // the raw signing secret, so it cannot verify HMAC itself — it POSTs
  // the inbound payload and signature here and the room checks them at
  // the single trusted boundary (sentinel -> real secret), answering
  // { valid }. Cross-identity reads 404 like the journal.
  const verifyDelivery = translate(async (req, res, { remoteAddress, subscriptionId }) => {
    rate(`agent-webhook-verify:${remoteAddress}`, 120);
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    const data = await body(req);
    if (!(data && exact(data, ["eventType", "data", "signature"])))
      reject(422, "invalid_verify_request", "eventType, data, and signature are the accepted fields");
    if (typeof data.eventType !== "string" || data.eventType.length === 0)
      reject(422, "invalid_verify_request", "eventType must be a non-empty string");
    if (data.data === null || typeof data.data !== "object")
      reject(422, "invalid_verify_request", "data must be an object");
    if (typeof data.signature !== "string" || data.signature.length === 0)
      reject(422, "invalid_verify_request", "signature must be a non-empty string");
    return json(res, 200, store.agentPlugin.verifyWebhookDelivery({
      identityId: auth.identityId,
      subscriptionId,
      eventType: data.eventType,
      data: data.data,
      signature: data.signature,
    }));
  });

  // RC-2026-09-19-064: signed dispatch surface. Deliveries are signed with
  // a fresh timestamp on every attempt (replay-resistant), retried with
  // backoff, and dead-lettered after exhaustion; this is where an agent
  // reads the whole picture, redrives dead letters, and measures the
  // falsifiable claim.
  const DELIVERY_REDRIVE_ROUTE = /^\/api\/agent-webhooks\/deliveries\/([A-Za-z0-9_-]{1,64})\/redrive$/;

  const deliveryLog = translate(async (req, res, { url }) => {
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    rate(`agent-webhooks-log:${auth.identityId}`, 120);
    const state = url.searchParams.get("state");
    const limit = url.searchParams.get("limit");
    return json(res, 200, {
      deliveries: store.agentPlugin.deliveryLogFor({ identityId: auth.identityId, state, limit }),
      next: [Object.freeze({ action: "dead-letter", method: "GET", path: "/api/agent-webhooks/dead-letter",
        description: "Deliveries that exhausted all attempts and need manual redrive." }),
        Object.freeze({ action: "metrics", method: "GET", path: "/api/agent-webhooks/metrics",
          description: "Delivery-rate metric measuring the falsifiable claim." })],
    });
  });

  const deadLetterQueue = translate(async (req, res, { url }) => {
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    rate(`agent-webhooks-dead-letter:${auth.identityId}`, 120);
    return json(res, 200, {
      deliveries: store.agentPlugin.deadLettersFor({ identityId: auth.identityId, limit: url.searchParams.get("limit") }),
      next: [Object.freeze({ action: "redrive", method: "POST",
        path: "/api/agent-webhooks/deliveries/{deliveryId}/redrive",
        description: "Redrive a dead-lettered delivery: it returns to pending with a clean attempt counter." })],
    });
  });

  const redriveDelivery = translate(async (req, res, { deliveryId }) => {
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    rate(`agent-webhooks-redrive:${auth.identityId}`, 60);
    return json(res, 200, {
      delivery: store.agentPlugin.redriveDeadLetter({ identityId: auth.identityId, deliveryId }),
    });
  });

  const deliveryMetrics = translate(async (req, res) => {
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    rate(`agent-webhooks-metrics:${auth.identityId}`, 120);
    return json(res, 200, store.agentPlugin.deliveryMetricsFor({ identityId: auth.identityId }));
  });

  // Agent-triggered dispatch sweep over the caller's own deliveries (the
  // Cloudflare cron sweeps everything globally). The point is dogfood and
  // repair: an agent can force delivery of its backlog without waiting for
  // the next tick, and rate limits keep it from hammering receivers.
  const processWebhooks = translate(async (req, res) => {
    const auth = agentAuth(req, requiredScope("webhooks:manage"));
    rate(`agent-webhooks-process:${auth.identityId}`, 12);
    const summary = await store.agentPlugin.drainWebhookDeliveries({ agentId: auth.identityId });
    return json(res, 200, { summary });
  });

  // RC-2026-09-18-049: identity verification tiers. The attester must be a
  // room owner (someone who owns at least one room); the attestation is
  // global to the identity. Reads are public so other agents can gate on
  // the tier.
  const VERIFY_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/verify$/;
  const VERIFICATION_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/verification$/;

  const verifyIdentity = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-identity-verify:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (!store.agentPlugin.isRoomOwner(auth.identityId)) {
      reject(403, "not_room_owner", "Only a room owner can attest an agent identity as verified");
    }
    if (!store.identities.get(identityId)) reject(404, "identity_not_found", "No such agent identity");
    return json(res, 201, store.agentPlugin.verifyIdentity({ identityId, verifiedBy: auth.identityId }));
  });

  const unverifyIdentity = translate(async (req, res, { identityId }) => {
    const auth = ownerAuth(req);
    if (!store.agentPlugin.isRoomOwner(auth.identityId)) {
      reject(403, "not_room_owner", "Only a room owner can revoke a verification attestation");
    }
    return json(res, 200, store.agentPlugin.unverifyIdentity({ identityId }));
  });

  const identityVerification = translate(async (req, res, { identityId }) => {
    const attestation = store.agentPlugin.verificationAttestation(identityId);
    return json(res, 200, attestation ?? { identityId, level: "unverified" });
  });

  // ---- Identity-secret rotate/revoke (RC-2026-09-19-055) ----
  //
  // The live-dogfood gap: identity pri_ secrets could never be invalidated.
  // The caller proves ownership by presenting the identity's OWN pri_
  // secret (ownerAuth rejects rak_ keys — a scoped credential must never
  // manage the master secret), and the path identity must equal the
  // authenticated identity: one identity can never rotate or revoke
  // another's. Rotate issues the new secret once and retires the old one
  // atomically; revoke is final — the secret stops authenticating
  // everywhere, the identity row stays for audit, and any scoped API keys
  // the identity minted are revoked too (on rotate as well: rotation is
  // the compromise response, so an attacker-minted key must not survive
  // it). Neither response ever carries the old secret.
  const SECRET_ROTATE_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/rotate$/;
  const SECRET_REVOKE_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/revoke$/;

  // Rotation is destructive and unrecoverable: the previous secret stops
  // authenticating the instant the new one is issued, and the new secret is
  // shown exactly once. An agent that calls this by accident — probing the
  // route, replaying a request, following a stale example — loses its
  // credential with no way back to the same identity, because the
  // replacement was in a response body it never meant to read. It then sees
  // a bare 401 on its next call, which is indistinguishable from an unknown
  // room or a pending access request, so it cannot even diagnose what
  // happened.
  //
  // So require the caller to say so explicitly, the same way the neighbouring
  // key rotation requires newPublicKey. An empty body no longer rotates
  // anything; it returns the required shape instead. requestId is optional
  // and echoed back, matching the access-request convention, so a client that
  // retries an uncertain rotation can correlate the receipt.
  const rotateIdentitySecret = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-identity-rotate:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only rotate its own secret");
    const data = await body(req);
    const shape = data && (exact(data, ["confirm"]) || exact(data, ["confirm", "requestId"]));
    if (!shape || data.confirm !== true) {
      reject(422, "confirm_required",
        "Rotation retires the current secret immediately and shows the replacement once. Send {\"confirm\":true} to proceed; requestId is optional.");
    }
    if (data.requestId !== undefined && (typeof data.requestId !== "string" || !data.requestId)) {
      reject(422, "invalid_request_id", "requestId must be a non-empty string when present");
    }
    const result = store.identities.rotate(identityId, bearer(req));
    return json(res, 200, data.requestId === undefined ? result : { ...result, requestId: data.requestId });
  });

  // Revocation is the end of the line for this credential: unlike rotation it
  // issues no replacement, so a caller that fires it by accident cannot get
  // back to the same identity at all. It gets the same explicit confirmation
  // as rotation, with a message that says plainly that nothing replaces it.
  const revokeIdentitySecret = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-identity-revoke:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only revoke its own secret");
    const data = await body(req);
    const shape = data && (exact(data, ["confirm"]) || exact(data, ["confirm", "requestId"]));
    if (!shape || data.confirm !== true) {
      reject(422, "confirm_required",
        "Revocation retires this secret immediately and issues nothing in its place; it cannot be undone. Rotate instead when you need continuity. Send {\"confirm\":true} to proceed; requestId is optional.");
    }
    if (data.requestId !== undefined && (typeof data.requestId !== "string" || !data.requestId)) {
      reject(422, "invalid_request_id", "requestId must be a non-empty string when present");
    }
    const result = store.identities.revoke(identityId, bearer(req));
    return json(res, 200, data.requestId === undefined ? result : { ...result, requestId: data.requestId });
  });

  // ---- Identity link codes (RC-2026-09-24-210) ----
  //
  // Proof-of-possession for identityId enrollment
  // (Uuriko/project-room#942, replacing the #948 interim disable). The
  // identity HOLDER mints a single-use enrollment code with their OWN pri_
  // secret — minting IS the holder's consent, and a sponsor's credential
  // or scoped API key can never mint (ownerAuth rejects rak_ keys, and the
  // path identity must equal the authenticated identity: one identity can
  // never mint for another). The sponsor presents the code as
  // identityLinkCode on agent-connections create; the server verifies hash
  // + binding + expiry + single-use and consumes it atomically. 10-minute
  // TTL; only the SHA-256 hash is stored, the raw code is returned once.
  const LINK_CODE_ROUTE = /^\/api\/identities\/([A-Za-z0-9_-]{1,64})\/link-code$/;

  const mintIdentityLinkCode = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`identity-link-code:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only mint link codes for itself");
    return json(res, 201, store.identities.mintLinkCode(identityId, bearer(req)));
  });

  // ---- Agent public-key registry (integration map slice 9) ----
  //
  // The registry is a room-local, operator-attested Ed25519 key directory:
  // identity -> { publicKey, validFrom, validUntil, revokedAt }. A key is
  // bound at identity issuance; the identity rotates or revokes its own
  // keys with the same ownership proof as identity-secret rotation (the
  // identity's own pri_ secret, path identity must match). The read surface
  // is public — public keys are public — and append-only, so past claims
  // stay checkable. Nothing here is trustless or decentralized: verifiers
  // trust the room operator's attestation.
  const KEY_LIST_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/keys$/;
  const KEY_ROTATE_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/keys\/rotate$/;
  const KEY_REVOKE_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/keys\/revoke$/;

  const listIdentityKeys = translate(async (req, res, { identityId }) => {
    if (!store.identities.get(identityId)) reject(404, "identity_not_found", "No such agent identity");
    return json(res, 200, { identityId, keys: store.keyRegistry.keysFor(identityId) });
  });

  const rotateIdentityKey = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-key-rotate:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only rotate its own keys");
    const data = await body(req);
    const shape = data && (exact(data, ["newPublicKey"]) || exact(data, ["newPublicKey", "overlapMs"]));
    if (!shape) reject(422, "invalid_key", "newPublicKey is required; overlapMs is optional");
    return json(res, 200, store.keyRegistry.rotateKey(identityId, {
      identitySecret: bearer(req), newPublicKey: data.newPublicKey, overlapMs: data.overlapMs }));
  });

  const revokeIdentityKey = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-key-revoke:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only revoke its own keys");
    const data = await body(req);
    if (!(data && exact(data, ["publicKey"]) && typeof data.publicKey === "string")) {
      reject(422, "invalid_key", "publicKey is required");
    }
    return json(res, 200, store.keyRegistry.revokeKey(identityId, {
      identitySecret: bearer(req), publicKey: data.publicKey }));
  });

  // ---- Wakeable agent presence (RC-2026-09-18-051; wakeable-by-default RC-2026-09-28-3602) ----
  //
  // POST /api/agent-heartbeats — an agent host reports liveness. mode
  // defaults to wakeable and wakeUrl is optional: with no public endpoint
  // the host waits on GET /api/agent-wakes/poll instead. The response
  // carries the agent's queued wake signals (one per mention or DM for
  // every registered host); the host acknowledges them via
  // POST /api/agent-heartbeats/ack once handled. GET reads the agent's
  // host presence. heartbeats:report posts and acks; heartbeats:read
  // reads. The owner identity secret grants both. A room access key for a
  // single-room linked agent may report and read pull-only presence for
  // itself; wake URLs and push stay on the identity secret.
  const heartbeatActor = createHeartbeatActor({ store, bearer, reject });
  const heartbeatNext = pendingWakes => pendingWakes.length > 0
    ? [Object.freeze({ action: "ack-wakes", method: "POST", path: "/api/agent-heartbeats/ack",
        description: "Acknowledge the wake signals you received (signalIds) so they stop being returned on the next heartbeat." })]
    : [];

  const reportHeartbeat = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-heartbeat:${remoteAddress}`, 120);
    const roomKey = isRoomAccessToken(bearer(req));
    let auth = heartbeatActor(req, requiredScope("heartbeats:report"));
    const initialIdentity = auth.identityId;
    const data = await body(req);
    // RC-2026-09-24-203: the body stays backward-compatible — hostId is
    // required; mode is optional and defaults to wakeable (RC-2026-09-28-3602).
    // wakeUrl / cadenceSeconds / pushNotification / workWakes are optional.
    const heartbeatFields = ["hostId", "mode", "wakeUrl", "cadenceSeconds", "pushNotification", "workWakes"];
    if (!data || !Object.keys(data).every(field => heartbeatFields.includes(field))
        || !Object.hasOwn(data, "hostId"))
      reject(422, "invalid_heartbeat", "hostId is required; mode defaults to wakeable; wakeUrl, cadenceSeconds, pushNotification and workWakes are optional");
    if (roomKey) assertRoomKeyPullOnly(store, auth.identityId, data);
    // Subscribe-time SSRF guard: the push url's hostname must resolve to a
    // public address BEFORE the sync heartbeat() upsert stores anything.
    // Shape validation (token, auth) happens inside heartbeat(). A room key
    // never reaches this check: pull-only refuses pushNotification first.
    else if (data.pushNotification !== undefined && data.pushNotification !== null) {
      await store.agentHeartbeats.assertPushDns(data.pushNotification.url);
    }
    // Q3-B: the store page includes `more` when pendingWakes is truncated.
    const { host, pendingWakes, more, wakeQueueStats, pushConfigured, pushSuspended, reachability } = store.transaction(() => {
      auth = heartbeatActor(req, requiredScope("heartbeats:report"));
      if (auth.identityId !== initialIdentity) reject(403, "identity_changed", "Credential identity changed during request");
      let hostId = data.hostId;
      if (roomKey) {
        assertRoomKeyPullOnly(store, auth.identityId, data);
        hostId = roomKeyHostId(auth, data.hostId);
        assertRoomKeyPullOnly(store, auth.identityId, { ...data, hostId });
      }
      const result = store.agentHeartbeats.heartbeat({
        agentId: auth.identityId, hostId, mode: data.mode,
        wakeUrl: data.wakeUrl ?? null, cadenceSeconds: data.cadenceSeconds ?? null,
        pushNotification: data.pushNotification ?? null, workWakes: data.workWakes, workScopeRoomId: roomKey ? auth.roomId : null });
      return result;
    });
    // A suspended push subscription tells the agent how to re-arm it: POST
    // a fresh pushNotification on the next heartbeat.
    const next = [...heartbeatNext(pendingWakes)];
    if (pushSuspended) next.push(Object.freeze({
      action: "rearm-push", method: "POST", path: "/api/agent-heartbeats",
      description: "Your push subscription was suspended after 3 failed deliveries; POST a fresh pushNotification to re-arm.",
    }));
    return json(res, 200, { agentId: auth.identityId, host, pendingWakes, more: more === true, next, pushConfigured, reachability, wakeQueueStats });
  });

  const ackHeartbeats = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-heartbeat-ack:${remoteAddress}`, 120);
    let auth = heartbeatActor(req, requiredScope("heartbeats:report"));
    const initialIdentity = auth.identityId;
    const data = await body(req);
    if (!data || !exact(data, ["signalIds"]) || !Array.isArray(data.signalIds))
      reject(422, "invalid_heartbeat_ack", "signalIds (a string array) is the accepted field");
    return json(res, 200, store.transaction(() => {
      auth = heartbeatActor(req, requiredScope("heartbeats:report"));
      if (auth.identityId !== initialIdentity) reject(403, "identity_changed", "Credential identity changed during request");
      return store.agentHeartbeats.ackWakes({ agentId: auth.identityId, signalIds: data.signalIds, roomId: auth.roomId ?? null });
    }));
  });

  const readHeartbeats = translate(async (req, res) => {
    const auth = heartbeatActor(req, requiredScope("heartbeats:read"));
    rate(`agent-heartbeats-read:${auth.identityId}`, 120);
    return json(res, 200, auth.roomId ? roomKeyPresenceView(store, auth) : store.agentHeartbeats.statusOf(auth.identityId));
  });

  // plan-wake-live: GET /api/wake-status lives in the route table
  // (server/routes/wake-status.mjs) — the OpenAPI route gate forbids new
  // legacy-chain registrations, so it must not be registered here. The
  // read-wake-status action descriptor above stays as discovery.

  // RC-2026-09-28-3602: room-hosted wake poll — the default wake path for
  // hosts with no public endpoint. waitMs (default 25000, max 55000)
  // bounds the hold; waitMs=0 is a pure short-poll read. Returns
  // immediately when a signal is already queued; otherwise holds until a
  // new mention/DM signal lands, the timeout expires, or the client
  // disconnects (the waiter slot is released on disconnect). Waiting never
  // acknowledges — the durable queue drains only through
  // POST /api/agent-heartbeats/ack. Room access keys wait on their own
  // room's signals only. One live waiter per host: a reconnect with the
  // same hostId replaces only that host's wait, so a reconnecting host
  // never wedges its slot and a second host's wait is never disturbed.
  const pollWakes = translate(async (req, res, { url }) => {
    const auth = heartbeatActor(req, requiredScope("heartbeats:read"));
    rate(`agent-wake-poll:${auth.identityId}`, 30);
    const roomId = auth.roomId ?? null;
    const hostId = url.searchParams.get("hostId");
    if (!hostId || !HOST_ID_PATTERN.test(hostId))
      reject(422, "invalid_wake_poll", "hostId is required (1-128 chars, [A-Za-z0-9._-]) — one wake waiter per host");
    const rawWait = url.searchParams.get("waitMs");
    let waitMs = 25000;
    if (rawWait !== null) {
      // NOTE: no anchored regex literal here — the route-docs extractor
      // mistakes caret-anchored literals in this file for route patterns.
      const text = rawWait.trim();
      const parsed = text === "" ? NaN : Number(text);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 55000)
        reject(422, "invalid_wake_poll", "waitMs must be 0..55000 milliseconds");
      waitMs = parsed;
    }
    const wakeNext = pendingWakes => [
      ...heartbeatNext(pendingWakes),
      Object.freeze({ action: "poll-wakes", method: "GET", path: "/api/agent-wakes/poll", requiredScope: "heartbeats:read",
        description: "Wait again for the next mention/DM: repeats the room-hosted wake poll." }),
    ];
    // Registering the waiter first is load-bearing: a reconnect with the
    // same hostId replaces only that host's previous wait, and the notePoll
    // right after closes the race where a signal landed between requests.
    let woken = false, clientGone = false, done = null;
    const donePromise = new Promise(resolve => { done = resolve; });
    const release = store.agentHeartbeats.addWakeWaiter(auth.identityId, auth.roomId ? roomKeyHostId(auth, hostId) : hostId, {
      roomId,
      onWake: () => { woken = true; done(); },
    });
    try {
      const immediate = store.agentHeartbeats.notePoll({ agentId: auth.identityId, roomId });
      if (!immediate.registered) reject(404, "agent_not_registered",
        "No host has reported for this identity yet — POST /api/agent-heartbeats first, then poll.");
      if (immediate.pendingWakes.length > 0 || waitMs === 0) {
        return json(res, 200, { agentId: auth.identityId, pendingWakes: immediate.pendingWakes,
          waitedMs: 0, timedOut: false, next: wakeNext(immediate.pendingWakes),
          wakeQueueStats: immediate.wakeQueueStats });
      }
      const startedAt = Date.now();
      const timer = setTimeout(done, waitMs);
      const onClose = () => { clientGone = true; done(); };
      req.on("close", onClose);
      try {
        await donePromise;
      } finally {
        clearTimeout(timer);
        req.removeListener("close", onClose);
      }
      if (clientGone) return undefined; // socket dead: nothing left to write
      // A held read cannot outlive its credential or room/identity binding.
      const current = heartbeatActor(req, requiredScope("heartbeats:read"));
      if (current.identityId !== auth.identityId || (current.roomId ?? null) !== roomId)
        reject(403, "identity_changed", "Credential binding changed during wake wait");
      const fresh = store.agentHeartbeats.notePoll({ agentId: current.identityId, roomId });
      const timedOut = !woken && fresh.pendingWakes.length === 0;
      return json(res, 200, { agentId: auth.identityId, pendingWakes: fresh.pendingWakes,
        waitedMs: Date.now() - startedAt, timedOut, next: wakeNext(fresh.pendingWakes),
        wakeQueueStats: fresh.wakeQueueStats });
    } finally {
      release();
    }
  });

  return async function handleAgentPluginRoutes(req, res, { url, remoteAddress }) {
    const pathname = url.pathname, method = req.method;
    if (pathname === "/api/agent-keys" && method === "POST") { await issueKey(req, res, { remoteAddress }); return true; }
    if (pathname === "/api/agent-keys" && method === "GET") { await listKeys(req, res); return true; }
    const keyActionMatch = method === "POST" ? KEY_ACTION_ROUTE.exec(pathname) : null;
    if (keyActionMatch) { await keyAction(req, res, { remoteAddress, keyId: keyActionMatch[1], action: keyActionMatch[2] }); return true; }
    if (pathname === "/api/agent-directory/cards" && method === "POST") { await publishCard(req, res, { remoteAddress }); return true; }
    if (pathname === "/api/agent-skills" && method === "POST") { await publishSkills(req, res, { remoteAddress }); return true; }
    const skillCardMatch = method === "GET" ? SKILL_CARD_ROUTE.exec(pathname) : null;
    if (skillCardMatch) { await skillCardDocument(req, res, { remoteAddress, identityId: skillCardMatch[1] }); return true; }
    if (pathname === "/api/agent-directory" && method === "GET") { await directoryDocument(req, res, { url }); return true; }
    if (pathname === "/api/agents/directory" && method === "GET") { await directoryDocument(req, res, { url }); return true; }
    const cardMatch = method === "DELETE" ? CARD_ROUTE.exec(pathname) : null;
    if (cardMatch) { await withdrawCard(req, res, { remoteAddress, agentId: cardMatch[1] }); return true; }
    const publicCardMatch = method === "GET" ? PUBLIC_CARD_ROUTE.exec(pathname) : null;
    if (publicCardMatch) { await cardDocument(req, res, { agentId: publicCardMatch[1] }); return true; }
    if ((pathname === "/api/agent-manifest" || pathname === WELL_KNOWN_PATH) && method === "GET") { await manifest(req, res); return true; }
    if (pathname === "/api/agent-webhooks" && method === "GET") { await listWebhooks(req, res); return true; }
    if (pathname === "/api/agent-webhooks" && method === "POST") { await subscribeWebhook(req, res, { remoteAddress }); return true; }
    const subMatch = method === "DELETE" ? SUBSCRIPTION_ROUTE.exec(pathname) : null;
    if (subMatch) { await unsubscribeWebhook(req, res, { remoteAddress, subscriptionId: subMatch[1] }); return true; }
    const deliveriesMatch = method === "GET" ? SUBSCRIPTION_DELIVERIES_ROUTE.exec(pathname) : null;
    if (deliveriesMatch) { await webhookDeliveries(req, res, { remoteAddress, subscriptionId: deliveriesMatch[1] }); return true; }
    const verifyDeliveryMatch = method === "POST" ? VERIFY_DELIVERY_ROUTE.exec(pathname) : null;
    if (verifyDeliveryMatch) { await verifyDelivery(req, res, { remoteAddress, subscriptionId: verifyDeliveryMatch[1] }); return true; }
    // RC-2026-09-19-064: signed dispatch surface (fixed paths before the
    // subscription-id regexes so they cannot shadow each other).
    if (pathname === "/api/agent-webhooks/deliveries" && method === "GET") { await deliveryLog(req, res, { url }); return true; }
    if (pathname === "/api/agent-webhooks/dead-letter" && method === "GET") { await deadLetterQueue(req, res, { url }); return true; }
    if (pathname === "/api/agent-webhooks/metrics" && method === "GET") { await deliveryMetrics(req, res); return true; }
    if (pathname === "/api/agent-webhooks/process" && method === "POST") { await processWebhooks(req, res); return true; }
    const redriveMatch = method === "POST" ? DELIVERY_REDRIVE_ROUTE.exec(pathname) : null;
    if (redriveMatch) { await redriveDelivery(req, res, { deliveryId: redriveMatch[1] }); return true; }
    const verifyMatch = method === "POST" ? VERIFY_ROUTE.exec(pathname) : null;
    if (verifyMatch) { await verifyIdentity(req, res, { remoteAddress, identityId: pathId(verifyMatch[1]) }); return true; }
    const unverifyMatch = method === "DELETE" ? VERIFY_ROUTE.exec(pathname) : null;
    if (unverifyMatch) { await unverifyIdentity(req, res, { identityId: pathId(unverifyMatch[1]) }); return true; }
    const verificationMatch = method === "GET" ? VERIFICATION_ROUTE.exec(pathname) : null;
    if (verificationMatch) { await identityVerification(req, res, { identityId: pathId(verificationMatch[1]) }); return true; }
    const secretRotateMatch = method === "POST" ? SECRET_ROTATE_ROUTE.exec(pathname) : null;
    if (secretRotateMatch) { await rotateIdentitySecret(req, res, { remoteAddress, identityId: pathId(secretRotateMatch[1]) }); return true; }
    const secretRevokeMatch = method === "POST" ? SECRET_REVOKE_ROUTE.exec(pathname) : null;
    if (secretRevokeMatch) { await revokeIdentitySecret(req, res, { remoteAddress, identityId: pathId(secretRevokeMatch[1]) }); return true; }
    // RC-2026-09-24-210: identity-holder proof-of-possession mint.
    const linkCodeMatch = method === "POST" ? LINK_CODE_ROUTE.exec(pathname) : null;
    if (linkCodeMatch) { await mintIdentityLinkCode(req, res, { remoteAddress, identityId: pathId(linkCodeMatch[1]) }); return true; }
    const keyListMatch = method === "GET" ? KEY_LIST_ROUTE.exec(pathname) : null;
    if (keyListMatch) { await listIdentityKeys(req, res, { identityId: pathId(keyListMatch[1]) }); return true; }
    const keyRotateMatch = method === "POST" ? KEY_ROTATE_ROUTE.exec(pathname) : null;
    if (keyRotateMatch) { await rotateIdentityKey(req, res, { remoteAddress, identityId: pathId(keyRotateMatch[1]) }); return true; }
    const keyRevokeMatch = method === "POST" ? KEY_REVOKE_ROUTE.exec(pathname) : null;
    if (keyRevokeMatch) { await revokeIdentityKey(req, res, { remoteAddress, identityId: pathId(keyRevokeMatch[1]) }); return true; }

    // RC-2026-09-18-051: wakeable agent presence.
    if (pathname === "/api/agent-heartbeats" && method === "POST") { await reportHeartbeat(req, res, { remoteAddress }); return true; }
    if (pathname === "/api/agent-heartbeats" && method === "GET") { await readHeartbeats(req, res); return true; }
    if (pathname === "/api/agent-heartbeats/ack" && method === "POST") { await ackHeartbeats(req, res, { remoteAddress }); return true; }
    // RC-2026-09-28-3602: room-hosted wake poll (before any regex routes).
    if (pathname === "/api/agent-wakes/poll" && method === "GET") { await pollWakes(req, res, { url }); return true; }
    return false;
  };
}
