// Public claim HTTP routes — the ONE public verb (John's directive 2026-09-30).
//
// Mounted by server/http.mjs in the PUBLIC (pre-auth) section, alongside
// /api/health and /api/version. These routes require NO room membership.
//
// Public (no auth):
//   GET  /api/claims            — list active claims
//   GET  /api/claims/{id}       — claim details
//   GET  /api/receipts/{id}     — verify a receipt
//
// Identity required (Bearer agent token, but NO room):
//   POST /api/claims                    — create a claim
//   POST /api/claims/{id}/heartbeat     — renew lease
//   POST /api/claims/{id}/release       — release early
//   POST /api/claims/{id}/complete      — complete with signed receipt
//
// Identity is resolved by the caller (http.mjs) via the agent token and
// passed as { id, displayName }. The route handler never touches rooms.
//
// Error contract: ClaimError (code invalid_claim_input) → 422;
// claim_conflict → 409; not_found → 404; not_authorized → 403;
// claim_not_active → 409.
import { createPublicClaimRegistry, ClaimError } from "./public-claims.mjs";

// Singleton registry (per-process). A future slice persists to store.mjs.
const registry = createPublicClaimRegistry();

const CLAIM_ID_RE = /^\/api\/claims\/([A-Za-z0-9_-]{1,128})$/;
const CLAIM_SUB_RE = /^\/api\/claims\/([A-Za-z0-9_-]{1,128})\/(heartbeat|release|complete)$/;
const RECEIPT_RE = /^\/api\/receipts\/([A-Za-z0-9_-]{1,128})$/;

function claimHttpError(error) {
  if (!(error instanceof ClaimError)) throw error;
  switch (error.code) {
    case "invalid_claim_input": return { status: 422, body: { status: "error", code: error.code, message: error.message } };
    case "claim_conflict": return { status: 409, body: { status: "error", code: error.code, message: error.message } };
    case "claim_not_active": return { status: 409, body: { status: "error", code: error.code, message: error.message } };
    case "not_found": return { status: 404, body: { status: "error", code: error.code, message: error.message } };
    case "not_authorized": return { status: 403, body: { status: "error", code: error.code, message: error.message } };
    default: throw error;
  }
}

// handlePublicClaims({ req, res, url, body, identity })
// - req, res: node http objects
// - url: parsed URL
// - body: async (req) => parsed JSON body (from http.mjs closure)
// - identity: { id, displayName } | null — resolved agent identity, or null
//   for unauthenticated requests (public reads allowed, writes rejected).
// Returns true if the route was handled, false to fall through.
export async function handlePublicClaims({ req, res, url, body, identity }) {
  const { pathname } = url;
  const method = req.method;

  const json = (status, obj) => {
    const bytes = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length });
    res.end(bytes);
    return true;
  };

  try {
    // GET /api/claims — public list.
    if (pathname === "/api/claims" && method === "GET") {
      const taskPrefix = url.searchParams.get("taskPrefix") || undefined;
      return json(200, { status: "ok", claims: registry.list({ taskPrefix }) });
    }

    // GET /api/receipts/{id} — public receipt verification.
    {
      const m = RECEIPT_RE.exec(pathname);
      if (m && method === "GET") {
        const result = registry.getReceipt(m[1]);
        if (!result) return json(404, { status: "error", code: "not_found", message: "Receipt not found." });
        return json(200, { status: "ok", ...result });
      }
    }

    // GET /api/claims/{id} — public claim details.
    {
      const m = CLAIM_ID_RE.exec(pathname);
      if (m && method === "GET" && !pathname.includes("/heartbeat") && !pathname.includes("/release") && !pathname.includes("/complete")) {
        const claim = registry.get(m[1]);
        if (!claim) return json(404, { status: "error", code: "not_found", message: "Claim not found." });
        return json(200, { status: "ok", claim });
      }
    }

    // Writes require an identity (but no room).
    const requireIdentity = () => {
      if (!identity || !identity.id) {
        json(401, { status: "error", code: "identity_required", message: "An agent identity (Bearer token) is required for this verb." });
        return false;
      }
      return true;
    };

    // POST /api/claims — create.
    if (pathname === "/api/claims" && method === "POST") {
      if (!requireIdentity()) return true;
      const data = await body(req);
      const claim = registry.create({
        taskId: data.taskId,
        claimant: { id: identity.id, displayName: identity.displayName || identity.id },
        scope: data.scope,
        leaseHours: data.leaseHours,
        intent: data.intent,
      });
      return json(201, { status: "ok", claim });
    }

    // POST /api/claims/{id}/{heartbeat|release|complete}
    {
      const m = CLAIM_SUB_RE.exec(pathname);
      if (m && method === "POST") {
        if (!requireIdentity()) return true;
        const [, id, action] = m;
        const data = action === "complete" || action === "release" ? await body(req).catch(() => ({})) : {};
        let result;
        if (action === "heartbeat") {
          result = { claim: registry.heartbeat(id, identity.id) };
        } else if (action === "release") {
          result = { claim: registry.release(id, identity.id, data.note) };
        } else {
          result = registry.complete(id, identity.id, {
            summary: data.summary,
            evidenceUrl: data.evidenceUrl,
            resultHash: data.resultHash,
          });
        }
        return json(200, { status: "ok", ...result });
      }
    }
  } catch (error) {
    const mapped = claimHttpError(error);
    return json(mapped.status, mapped.body);
  }

  return false;
}

// For testing: access the singleton registry.
export function _publicClaimRegistry() {
  return registry;
}
