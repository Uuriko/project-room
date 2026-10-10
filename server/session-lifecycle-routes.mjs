// REST routes for the worker-side session lifecycle (build lane B14).
//
// Room-scoped handlers in the repo's mounting convention (cf.
// server/work-claim-routes.mjs): handleSessionLifecycle({ req, res, url,
// store, roomId, auth, lifecycleRoute, lifecycleId, helpers, lifecycle }).
//
// UNMOUNTED: http.mjs wiring is the integration step's job (this lane must
// not touch server/http.mjs). The integration mount matches on:
//   POST   /api/rooms/{roomId}/herdr-sessions
//   GET    /api/rooms/{roomId}/herdr-sessions[?claimId&laneMemberId&state&limit&after]
//   GET    /api/rooms/{roomId}/herdr-sessions/{id}
//   GET    /api/rooms/{roomId}/herdr-sessions/{id}/journal[?limit&after]
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/attach
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/heartbeat
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/detach
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/reattach
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/suspend
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/resume
//   POST   /api/rooms/{roomId}/herdr-sessions/{id}/destroy
//
// NOT registered in scripts/runtime-package.mjs either — deferred to the
// integration step (lease on runtime-package.mjs respected). Both noted in
// the PR.
//
// Domain-error → HTTP mapping per D2 §2.9. Error vocabulary is append-only
// per compat-plan §2.7: existing codes keep their meaning; herdr codes are
// new and never replace an existing code on an existing path.
//
// Worker-safe: no node:net.
import {
  createSessionLifecycle,
  SessionLifecycleError,
} from "./session-lifecycle.mjs";

// D2 §2.9: domain error → HTTP status + code.
const domainHttp = err => {
  switch (err?.name) {
    case "VersionMismatchError": return [503, "herdr_version_mismatch"];
    case "OccupantChangedError": return [409, "session_occupant_changed"];
    case "MethodUnsupportedError": return [501, "herdr_method_unsupported"];
    case "TransportError": return [err.timeout ? 504 : 502, "herdr_transport_error"];
    case "TimeoutError": return [504, "herdr_timeout"];
    case "ServerError": return [500, "herdr_server_error"];
    default: return null;
  }
};

// Strict body shapes: every required key present, no unknown keys (repo
// convention from work-claim-routes).
const shape = (fields, { required = [], optional = [] } = {}) => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => allowed.has(key));
};

const CREATE_REQUIRED = ["idempotencyKey", "claimId", "laneMemberId", "tenantId", "kind"];
const CREATE_OPTIONAL = ["roomId", "resumeSessionRef", "resumeCommand", "cwd", "workspace", "tab", "title", "metadata", "spawnTimeoutMs"];
const ATTACH_REQUIRED = ["idempotencyKey", "claimId"];
const ATTACH_OPTIONAL = ["sessionId", "paneId", "laneMemberId", "verifyOccupant"];

export async function handleSessionLifecycle({
  req, res, url, store, roomId, auth, lifecycleRoute, lifecycleId, helpers, lifecycle = null,
}) {
  const { json, reject, body } = helpers;
  const lc = lifecycle ?? createSessionLifecycle(store);
  const caller = auth?.member?.id;
  if (!caller) reject(401, "lifecycle_unauthorized", "authentication required");

  const fail = err => {
    if (err instanceof SessionLifecycleError) reject(err.status, err.code, err.message);
    const mapped = domainHttp(err);
    if (mapped) reject(mapped[0], mapped[1], err.message);
    throw err; // unknown — the generic 500 path, never wrapped
  };
  const invalidInput = what => reject(422, "invalid_lifecycle_input", `invalid request body: expected ${what}`);

  // Ownership: a member drives only their own sessions. Attach defaults the
  // adopting laneMemberId to the caller (adoption of another member's session
  // goes through the board-driven onClaimEvent path, never a direct route).
  const loadOwned = async id => {
    let info;
    try { info = await lc.getSession(id); } catch (e) { fail(e); }
    if (info.laneMemberId !== caller) {
      reject(403, "session_not_owner",
        `session "${id}" belongs to ${info.laneMemberId} — only the owning lane member can drive it`);
    }
    return info;
  };
  const checkCallerIs = laneMemberId => {
    if (laneMemberId !== caller) {
      reject(403, "session_not_owner", "laneMemberId must be the calling member — sessions are caller-owned");
    }
  };

  const method = req.method;
  const need = (m, route) => {
    if (method !== m) reject(405, "method_not_allowed", `${route} requires ${m}`);
  };

  try {
    if (lifecycleRoute === "create") {
      need("POST", "create");
      const data = await body(req);
      if (!shape(data, { required: CREATE_REQUIRED, optional: CREATE_OPTIONAL })) {
        invalidInput(`{${[...CREATE_REQUIRED, ...CREATE_OPTIONAL].join(", ")}}`);
      }
      checkCallerIs(data.laneMemberId);
      const session = await lc.spawnSession({ ...data, roomId: data.roomId ?? roomId });
      // D2 §4.4: 201 on create, 200 on idempotent duplicate (work-session parity).
      return json(res, session.duplicate ? 200 : 201, { roomId, session });
    }

    if (lifecycleRoute === "list") {
      need("GET", "list");
      const params = url.searchParams;
      const laneMemberId = params.get("laneMemberId") ?? caller;
      checkCallerIs(laneMemberId); // reads are caller-scoped; supervisors use diagnostics
      let limit = 50;
      if (params.has("limit")) {
        const raw = params.get("limit");
        if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 200) invalidInput("limit as an integer 1..200");
        limit = Number(raw);
      }
      const result = await lc.listSessions({
        roomId,
        claimId: params.get("claimId"),
        laneMemberId,
        state: params.get("state"),
        limit,
        after: params.get("after"),
      });
      return json(res, 200, { roomId, ...result });
    }

    if (lifecycleRoute === "item") {
      need("GET", "item");
      const info = await loadOwned(lifecycleId);
      return json(res, 200, { roomId, session: info });
    }

    if (lifecycleRoute === "journal") {
      need("GET", "journal");
      await loadOwned(lifecycleId);
      const params = url.searchParams;
      let limit = 100;
      if (params.has("limit")) {
        const raw = params.get("limit");
        if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 500) invalidInput("limit as an integer 1..500");
        limit = Number(raw);
      }
      let after = null;
      if (params.has("after")) {
        const raw = params.get("after");
        if (!/^[1-9]\d*$/.test(raw)) invalidInput("after as a journal id");
        after = Number(raw);
      }
      const result = await lc.sessionJournal(lifecycleId, { limit, after });
      return json(res, 200, { roomId, sessionId: lifecycleId, ...result });
    }

    if (lifecycleRoute === "attach") {
      need("POST", "attach");
      const data = await body(req);
      if (!shape(data, { required: ATTACH_REQUIRED, optional: ATTACH_OPTIONAL })) {
        invalidInput(`{${[...ATTACH_REQUIRED, ...ATTACH_OPTIONAL].join(", ")}}`);
      }
      const laneMemberId = data.laneMemberId ?? caller;
      checkCallerIs(laneMemberId);
      const targetId = data.sessionId ?? lifecycleId;
      if (data.sessionId) await loadOwned(data.sessionId);
      else await loadOwned(lifecycleId);
      const session = await lc.attachSession({ ...data, sessionId: targetId, laneMemberId });
      return json(res, 200, { roomId, session });
    }

    if (lifecycleRoute === "heartbeat") {
      need("POST", "heartbeat");
      const data = await body(req);
      if (!shape(data, { required: ["occupantId"], optional: ["idempotencyKey", "reportedAgentState"] })) {
        invalidInput("{occupantId, idempotencyKey?, reportedAgentState?}");
      }
      await loadOwned(lifecycleId);
      const beat = await lc.heartbeatSession({ ...data, sessionId: lifecycleId });
      return json(res, 200, { roomId, ...beat });
    }

    if (lifecycleRoute === "detach") {
      need("POST", "detach");
      const data = await body(req);
      if (!shape(data, { required: ["idempotencyKey", "reason"] })) invalidInput("{idempotencyKey, reason}");
      await loadOwned(lifecycleId);
      const session = await lc.detachSession({ ...data, sessionId: lifecycleId });
      return json(res, 200, { roomId, session });
    }

    if (lifecycleRoute === "reattach") {
      need("POST", "reattach");
      const data = await body(req);
      if (!shape(data, { required: ["idempotencyKey"], optional: ["forceRepin", "resumeTimeoutMs"] })) {
        invalidInput("{idempotencyKey, forceRepin?, resumeTimeoutMs?}");
      }
      await loadOwned(lifecycleId);
      const session = await lc.reattachSession({ ...data, sessionId: lifecycleId });
      return json(res, 200, { roomId, session });
    }

    if (lifecycleRoute === "suspend") {
      need("POST", "suspend");
      const data = await body(req);
      if (!shape(data, { required: ["idempotencyKey", "reason"] })) invalidInput("{idempotencyKey, reason}");
      await loadOwned(lifecycleId);
      const session = await lc.suspendSession({ ...data, sessionId: lifecycleId });
      return json(res, 200, { roomId, session });
    }

    if (lifecycleRoute === "resume") {
      need("POST", "resume");
      const data = await body(req);
      if (!shape(data, { required: ["idempotencyKey"], optional: ["forceRepin", "resumeTimeoutMs"] })) {
        invalidInput("{idempotencyKey, forceRepin?, resumeTimeoutMs?}");
      }
      await loadOwned(lifecycleId);
      const session = await lc.resumeSession({ ...data, sessionId: lifecycleId });
      return json(res, 200, { roomId, session });
    }

    if (lifecycleRoute === "destroy") {
      need("POST", "destroy");
      const data = await body(req);
      if (!shape(data, { required: ["idempotencyKey", "reason"], optional: ["graceMs", "closePane"] })) {
        invalidInput("{idempotencyKey, reason, graceMs?, closePane?}");
      }
      await loadOwned(lifecycleId);
      const session = await lc.destroySession({ ...data, sessionId: lifecycleId });
      return json(res, 200, { roomId, session });
    }

    reject(404, "lifecycle_unknown_route", `unknown session-lifecycle route "${lifecycleRoute}"`);
  } catch (e) {
    fail(e);
  }
}
