// A read-only projection, not an authorization grant, verifier or host launcher.
// Inputs must come from authenticated reads and the selected host's diagnostics,
// never from Room message text. It deliberately accepts no credential or body.
// observedAfter and observation receipt times use the caller's clock.
// checkedAt may come from a local client or the server; do not compare it
// directly with that caller's wall clock or manufacture a receipt for cache.
// Host observations are optional. A live host is not proof of an idle wake.
// No trusted causal background adapter exists here yet: run-shaped inputs,
// installation, heartbeat, callback and schedule hints cannot verify execution.
const time = value => typeof value === "number" && Number.isSafeInteger(value) ? value
  : typeof value === "string" ? Date.parse(value) : NaN;
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const bound = (value, expected) => value?.roomId === expected.roomId && value?.memberId === expected.memberId;

export function agentConnectionReadiness({ expected = {}, access = null, activationPack = null,
  accessObservedAt, activationObservedAt, host = null, exchange = null, observedAfter, now } = {}) {
  const windowValid = Number.isSafeInteger(now) && Number.isSafeInteger(observedAfter) && observedAfter >= 0 && observedAfter <= now;
  const fresh = value => windowValid && time(value) >= observedAfter && time(value) <= now;
  const dated = value => Number.isFinite(time(value)) && time(value) >= 0;
  const identityValid = id(expected.roomId) && id(expected.memberId);
  const authenticated = Boolean(identityValid && access?.contractVersion === 1
    && access.type === "agent_connection_check" && access.status === "credential_accepted"
    && access.kind === "agent" && access.scope === "room" && access.externalExecution === false
    && bound(access, expected) && dated(access.checkedAt) && fresh(accessObservedAt)
    // Expiry and checkedAt belong to the access producer. Anchor their
    // remaining interval conservatively at this check's local start.
    && (access.expiresAt === null || Number.isSafeInteger(access.expiresAt)
      && access.expiresAt-time(access.checkedAt) > now-observedAfter));
  const read = Boolean(authenticated && activationPack?.view === "brief"
    && activationPack.room?.slug === expected.roomId && activationPack.you?.memberId === expected.memberId
    // generatedAt belongs to the server clock; receipt time belongs to this
    // check. Never manufacture receipt time when replaying a cached pack.
    && Number.isFinite(time(activationPack.generatedAt)) && fresh(activationObservedAt));
  const hostBound = id(expected.hostId) && host?.hostId === expected.hostId && bound(host, expected);
  const available = Boolean(read && hostBound && ["dot", "codex"].includes(host.kind)
    && id(host.instanceId) && ["active_session", "background"].includes(host.mode)
    && host.state === "available" && fresh(host.observedAt)
    && Number.isFinite(time(host.validUntil)) && time(host.validUntil) > now);

  // A fresh selected-request read can prove a saved reply, not which host
  // produced it or whether a background wake caused it. Server timestamps
  // are compared only to each other, never to the client's wall clock.
  const response = exchange?.response, request = response?.request;
  const answered = Boolean(authenticated && response?.contractVersion === 1 && response.roomId === expected.roomId
    && response.viewerId === expected.memberId && response.hasMore === false
    && fresh(exchange.observedAt) && request?.recipientId === expected.memberId
    && id(request.requesterId) && request.requesterId !== expected.memberId
    && request.status === "answered" && response.current?.recipientAvailable === true
    && [request.id, request.responseMessageId, request.terminalEventId].every(id)
    && dated(request.createdAt) && dated(request.closedAt)
    && time(request.createdAt) <= time(request.closedAt));
  const status = !authenticated ? "not_connected" : !read ? "authenticated"
    : !available ? "usable" : host.mode === "active_session" ? "active_session_only"
      : "background_unverified";
  // The first four fields preserve agent-setup's existing readiness contract.
  // A saved reply never overrides current access, context or host expiry/stop.
  // Listening/execution remain untested until an actual causal adapter exists.
  return Object.freeze({ access: authenticated ? "verified" : "not_tested", read: read ? "verified" : "not_tested",
    listening: "not_tested", execution: "not_tested",
    contractVersion: 1, status, currentlyAvailable: available, externalExecution: false,
    backgroundVerification: "unsupported", lastBackgroundProof: null,
    savedReply: answered ? Object.freeze({ requestMessageId: request.id,
      responseMessageId: request.responseMessageId, responseEventId: request.terminalEventId,
      at: request.closedAt }) : null });
}
