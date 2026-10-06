// POST /api/github/pr-webhook — GitHub pull_request webhook receiver for
// claim auto-linking (plan-pr-autolink).
//
// OFF BY DEFAULT: without ROOM_PR_WEBHOOK=1 (or true/yes) the route answers
// 404, indistinguishable from no route. Enabled without the
// GITHUB_PR_WEBHOOK_SECRET secret it fails closed with 503. Deliveries are
// HMAC-verified with the existing github-app verifier (constant-time); the
// secret value is never logged, stored, or echoed — only its env var NAME is
// documented (ops__STATE.md). Responses are minimal (claim id + PR number +
// state); PR bodies are never echoed back. No debug endpoint points at a
// public URL.
//
// Mounted through the declarative route table (server/routes/table.mjs);
// the table registration + openapi doc are a coordinated handoff with the
// claude-code-drops lane, which owns those two files right now.
import { parseEvent, verifyWebhook, WEBHOOK_BODY_LIMIT } from "../github-app/verify.mjs";
import {
  handlePrWebhookPayload,
  prWebhookEnabled,
  PR_WEBHOOK_FLAG,
  PR_WEBHOOK_SECRET_ENV,
} from "../claim-autolink.mjs";

function liveEnv() {
  const proc = globalThis.process;
  return proc && proc.env && typeof proc.env === "object" ? proc.env : {};
}

export async function postPrWebhook(ctx) {
  const env = liveEnv();
  if (!prWebhookEnabled(env)) ctx.reject(404, "not_found", "Not found");
  ctx.rate(`pr-webhook:${ctx.remoteAddress ?? "unknown"}`, 120);
  const secret = typeof env[PR_WEBHOOK_SECRET_ENV] === "string" ? env[PR_WEBHOOK_SECRET_ENV] : "";
  if (!secret) ctx.reject(503, "webhook_unconfigured", "The PR webhook is enabled but its secret is not configured");
  const text = await ctx.readText(ctx.req, WEBHOOK_BODY_LIMIT, () => ctx.reject(413, "too_large", "Request is too large"));
  const check = await verifyWebhook({
    rawBody: text,
    signature256: ctx.req.headers["x-hub-signature-256"],
    secret,
  });
  if (!check.ok) ctx.reject(401, "webhook_signature", "Bad webhook signature");
  const parsedEvent = parseEvent(ctx.req.headers, text);
  if (parsedEvent.ignored || parsedEvent.event !== "pull_request") {
    return ctx.json(ctx.res, 200, { ok: true, ignored: true });
  }
  const result = handlePrWebhookPayload(ctx.store, parsedEvent.payload, { nowMs: Date.now() });
  if (!result.ok) return ctx.json(ctx.res, 200, { ok: true, ignored: true, reason: result.reason });
  // Minimal by design: claim id, PR number, and state. Nothing else.
  return ctx.json(ctx.res, 200, {
    ok: true,
    event: "pull_request",
    action: result.action,
    linked: result.linked ? result.linked.claimId : null,
    settled: result.settled.map(entry => ({ claimId: entry.claimId, outcome: entry.outcome })),
  });
}

export const PR_WEBHOOK_ROUTES = Object.freeze([
  Object.freeze({
    id: "pr.webhook", method: "POST", path: "/api/github/pr-webhook",
    auth: "none", capability: null, scope: "worker", handler: postPrWebhook,
    schema: { body: { type: "object" }, response: { type: "object" } },
    events: [],
  }),
]);

// Names the operator records when enabling the webhook. Exported so the
// ops doc and the route stay in sync; the VALUE never enters the repo.
export const PR_WEBHOOK_OPS = Object.freeze({ flag: PR_WEBHOOK_FLAG, secretEnv: PR_WEBHOOK_SECRET_ENV });
