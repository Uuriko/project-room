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
// Secrets are shown exactly once (at issue, rotate, and server-generated
// webhook-secret subscribe); list outputs never include them. Pure-module
// validation errors surface as 422 (404 for unknown/not-found codes);
// cross-identity access reads as 404, never an oracle.
//
// Mounted from server/http.mjs via createAgentPluginRoutes, which receives
// the server's local helpers. handleAgentPluginRoutes returns true when it
// served the request, false so http.mjs can fall through to other routes.
import { validatePluginManifest, WELL_KNOWN_PATH } from "./agent-plugin-manifest.mjs";
import { AgentPluginError } from "./agent-plugin-store.mjs";
import { API_KEY_SCOPES, API_KEY_PREFIX } from "./agent-api-keys.mjs";
import { EVENT_TYPES } from "../src/events.js";

// RC-2026-09-18-031: the room event vocabulary webhooks may subscribe to.
// Derived from EVENT_TYPES so the taught list can never drift from what the
// dispatcher actually emits; "*" subscribes to every event type.
// RC-2026-09-18-051: "agent.wake" is not a room event — it is the
// identity-scoped wake ping journaled when an offline agent is mentioned or
// DM'd. Listed here so an agent can subscribe to its own wake pings.
const WAKE_PING_EVENT = "agent.wake";
const WEBHOOK_EVENTS = Object.freeze([...Object.values(EVENT_TYPES).sort(), WAKE_PING_EVENT, "*"]);

// Scope vocabulary is the single source of truth in
// server/agent-api-keys.mjs (API_KEY_SCOPES): requiredScope names below
// must resolve there, so a scope can never be enforced but undocumented.
const requiredScope = name => {
  const entry = API_KEY_SCOPES.find(scope => scope.scope === name);
  if (!entry) throw new Error(`unknown agent API-key scope: ${name}`);
  return entry.scope;
};

const KEY_ACTION_ROUTE = /^\/api\/agent-keys\/(rak_[A-Za-z0-9_-]{1,64})\/(rotate|revoke)$/;
const SUBSCRIPTION_ROUTE = /^\/api\/agent-webhooks\/([A-Za-z0-9_-]{1,64})$/;
const SUBSCRIPTION_DELIVERIES_ROUTE = /^\/api\/agent-webhooks\/([A-Za-z0-9_-]{1,64})\/deliveries$/;
const CARD_ROUTE = /^\/api\/agent-directory\/cards\/([A-Za-z0-9_-]{1,120})$/;
const PUBLIC_CARD_ROUTE = /^\/api\/agents\/directory\/([a-z][a-z0-9-]{0,119})$/;

export function createAgentPluginRoutes({ store, json, reject, body, rate, bearer, exact, pathId, origin }) {
  // Coded pure-module errors -> HTTP: unknown/not-found reads as 404,
  // validation as 422. Ownership errors come from the sub-store as
  // AgentPluginError with their own status.
  const translate = handler => async (...args) => {
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
  const grants = (scopes, required) => (scopes ?? []).some(scope =>
    scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))));

  // Full agent credential: the pri_ identity secret (owner, full
  // permissions) or a rak_ API key (scoped to its stored scopes).
  // requiredScope denies scoped keys without it (403 insufficient_scope).
  // Returns { identityId, keyId, scopes }; scopes is null for the owner.
  const agentAuth = (req, requiredScope = null) => {
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
      if (requiredScope && !grants(record.scopes, requiredScope))
        reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
      return { identityId: record.identityId, keyId: record.keyId, scopes: record.scopes };
    }
    reject(401, "unauthenticated", "Agent credential required");
  };

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
      if (!grants(record.scopes, "directory:read")) return null;
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
      description: "Report this host's liveness (hostId, mode wakeable|pull-only, wakeUrl for wakeable hosts). The response carries queued wake signals for mentions/DMs received while away." }),
    Object.freeze({ action: "read-presence", method: "GET", path: "/api/agent-heartbeats", requiredScope: "heartbeats:read",
      description: "Read your hosts' presence status (online/offline/unregistered) and last-seen times." }),
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
    return json(res, 200, { keys, next });
  });

  const keyAction = translate(async (req, res, { remoteAddress, keyId, action }) => {
    rate(`agent-key-${action}:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    const result = action === "rotate"
      ? withCredential(store.agentPlugin.rotateApiKey({ identityId: auth.identityId, keyId }))
      : store.agentPlugin.revokeApiKey({ identityId: auth.identityId, keyId });
    return json(res, 200, result);
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
    return json(res, 200, member
      ? store.agentPlugin.memberCard(agentId, member.identityId)
      : store.agentPlugin.publicCard(agentId));
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
          description: "No subscriptions yet — POST { url, events } to subscribe. events uses dotted names (e.g. message.posted); a signing secret is shown exactly once in the 201." })]
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
    if (data.secret !== undefined && data.secret !== null && typeof data.secret !== "string")
      reject(422, "invalid_subscription_request", "secret must be a string when given");
    const { subscription, secretShownOnce } = store.agentPlugin.subscribeWebhook({
      identityId: auth.identityId,
      url: data.url,
      events: data.events,
      secret: data.secret ?? null,
    });
    // A server-generated signing secret is shown exactly once here; a
    // caller-supplied one is never echoed back. RC-2026-09-18-039: the
    // response names the secret's job — store it now, verify HMAC on
    // inbound deliveries, and check the journal for failures.
    const subscribeNext = (subscriptionId, hasSecret) => {
      const steps = [
        Object.freeze({ action: "verify-deliveries", description:
          "Verify inbound deliveries with HMAC-SHA256 over the payload using this subscription's signing secret." }),
        Object.freeze({ action: "check-journal", method: "GET",
          path: `/api/agent-webhooks/${encodeURIComponent(subscriptionId)}/deliveries`,
          description: "Read the per-subscription delivery journal: pending/delivered/failed/dead_letter states, attempts, and errors. Dead letters redrive at POST /api/agent-webhooks/deliveries/{deliveryId}/redrive; the delivery rate is at GET /api/agent-webhooks/metrics." }),
      ];
      if (hasSecret) {
        steps.unshift(Object.freeze({ action: "store-secret",
          description: "Store this signing secret NOW — it is shown exactly once and never returned again. Losing it means recreating the subscription." }));
      }
      return Object.freeze(steps);
    };
    const responseBody = secretShownOnce
      ? { ...subscription, secret: secretShownOnce, next: subscribeNext(subscription.subscriptionId, true) }
      : { ...subscription, next: subscribeNext(subscription.subscriptionId, false) };
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
  // the identity minted are revoked too. Neither response ever carries the
  // old secret.
  const SECRET_ROTATE_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/rotate$/;
  const SECRET_REVOKE_ROUTE = /^\/api\/agent-identities\/([A-Za-z0-9_-]{1,64})\/revoke$/;

  const rotateIdentitySecret = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-identity-rotate:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only rotate its own secret");
    return json(res, 200, store.identities.rotate(identityId, bearer(req)));
  });

  const revokeIdentitySecret = translate(async (req, res, { remoteAddress, identityId }) => {
    rate(`agent-identity-revoke:${remoteAddress}`, 20);
    const auth = ownerAuth(req);
    if (auth.identityId !== identityId) reject(403, "cross_identity", "An identity can only revoke its own secret");
    return json(res, 200, store.identities.revoke(identityId, bearer(req)));
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

  // ---- Wakeable agent presence (RC-2026-09-18-051) ----
  //
  // POST /api/agent-heartbeats — an agent host reports liveness. The
  // response carries the agent's queued wake signals (mentions/DMs that
  // arrived while the agent was offline); the host acknowledges them via
  // POST /api/agent-heartbeats/ack once handled. GET reads the agent's
  // host presence. heartbeats:report posts and acks; heartbeats:read
  // reads. The owner identity secret grants both.
  const heartbeatNext = pendingWakes => pendingWakes.length > 0
    ? [Object.freeze({ action: "ack-wakes", method: "POST", path: "/api/agent-heartbeats/ack",
        description: "Acknowledge the wake signals you received (signalIds) so they stop being returned on the next heartbeat." })]
    : [];

  const reportHeartbeat = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-heartbeat:${remoteAddress}`, 120);
    const auth = agentAuth(req, requiredScope("heartbeats:report"));
    const data = await body(req);
    if (!data || !(exact(data, ["hostId", "mode"]) || exact(data, ["hostId", "mode", "wakeUrl"])))
      reject(422, "invalid_heartbeat", "hostId and mode (wakeable|pull-only), with optional wakeUrl, are the accepted fields");
    const { host, pendingWakes } = store.agentHeartbeats.heartbeat({
      agentId: auth.identityId, hostId: data.hostId, mode: data.mode, wakeUrl: data.wakeUrl ?? null });
    return json(res, 200, { agentId: auth.identityId, host, pendingWakes, next: heartbeatNext(pendingWakes) });
  });

  const ackHeartbeats = translate(async (req, res, { remoteAddress }) => {
    rate(`agent-heartbeat-ack:${remoteAddress}`, 120);
    const auth = agentAuth(req, requiredScope("heartbeats:report"));
    const data = await body(req);
    if (!data || !exact(data, ["signalIds"]) || !Array.isArray(data.signalIds))
      reject(422, "invalid_heartbeat_ack", "signalIds (a string array) is the accepted field");
    return json(res, 200, store.agentHeartbeats.ackWakes({ agentId: auth.identityId, signalIds: data.signalIds }));
  });

  const readHeartbeats = translate(async (req, res) => {
    const auth = agentAuth(req, requiredScope("heartbeats:read"));
    rate(`agent-heartbeats-read:${auth.identityId}`, 120);
    return json(res, 200, store.agentHeartbeats.statusOf(auth.identityId));
  });

  return async function handleAgentPluginRoutes(req, res, { url, remoteAddress }) {
    const pathname = url.pathname, method = req.method;
    if (pathname === "/api/agent-keys" && method === "POST") { await issueKey(req, res, { remoteAddress }); return true; }
    if (pathname === "/api/agent-keys" && method === "GET") { await listKeys(req, res); return true; }
    const keyActionMatch = method === "POST" ? KEY_ACTION_ROUTE.exec(pathname) : null;
    if (keyActionMatch) { await keyAction(req, res, { remoteAddress, keyId: keyActionMatch[1], action: keyActionMatch[2] }); return true; }
    if (pathname === "/api/agent-directory/cards" && method === "POST") { await publishCard(req, res, { remoteAddress }); return true; }
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
    return false;
  };
}
