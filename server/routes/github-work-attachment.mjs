import { parsePullRequestUrl } from "../claim-coordination.mjs";
import { attachGithubWork } from "../github-work-attachment.mjs";
import { observeWebhookPull, queueAttachedGithubReview, readGithubReviewWebhookBinding } from "../github-review-webhook.mjs";

async function attach(ctx) {
  const { req, res, url, store } = ctx, { roomId } = ctx.params;
  const selected = ctx.roomCredentials(req, url);
  const fence = ctx.expectedBinding(req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!selected.bearer || auth.credentialScope !== "room")
    ctx.reject(403, "access_denied", "A Room bearer identity is required.");
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*"))
    ctx.reject(403, "insufficient_scope", "This key cannot modify Room work.");
  ctx.protectWrite(req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  const input = await ctx.body(req, { limit: 4096 });
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["workItemId", "operationId", "pullRequest", "expectedHead", "expectedRevision", "refreshHead"].includes(key)))
    ctx.reject(422, "invalid_pr_attachment", "Supply the documented exact PR attachment fields.");
  if (input.refreshHead !== undefined && !/^[a-f0-9]{40}$/.test(input.refreshHead))
    ctx.reject(422, "invalid_refresh_head", "Supply an exact head for refresh.");
  const env = process.env;
  const binding = env.ROOM_GITHUB_REVIEW_RECIPE
    ? readGithubReviewWebhookBinding(JSON.parse(env.ROOM_GITHUB_REVIEW_RECIPE)) : null;
  if (binding?.pulls.includes(parsePullRequestUrl(input.pullRequest)?.number))
    ctx.reject(409, "static_review_binding", "This PR already uses the room's static review lane.");
  const reply = await attachGithubWork(store, { token: selected.token, roomId, input, fence, recipe: binding?.recipe,
    observe: (recipe, candidate) => observeWebhookPull(recipe, candidate, { token: env.GH_TOKEN || env.GITHUB_TOKEN, includeInactive: true }) });
  // Reconcile even when check completion preceded the attachment. An explicit
  // replay also gives a producer a recovery route for missing webhook delivery.
  const head = input.refreshHead ?? reply.observedHead;
  queueAttachedGithubReview(store, { event: "pull_request", action: "synchronize",
    delivery: reply.receiptOperationId + "-" + head.slice(0, 12),
    payload: { repository: { full_name: reply.repository }, pull_request: { number: reply.number, head: { sha: head } } } }, env);
  return ctx.json(res, reply.replayed ? 200 : 201, reply);
}

export const GITHUB_WORK_ATTACHMENT_ROUTE = Object.freeze({
  id: "github-work-attachment", method: "POST", path: "/api/rooms/{roomId}/github-work-attachment",
  auth: "room", capability: null, scope: "room",
  parity: "exempt:structured CLI attachment uses the existing Room bearer transport",
  handler: attach, schema: { body: { type: "object" }, response: { type: "object" } }, events: ["message.posted"],
});
