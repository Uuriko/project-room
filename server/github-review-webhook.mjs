import { createHash } from "node:crypto";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { evaluateGithubReview, readGithubReviewRecipe } from "../client/github-review-recipe.mjs";
import { validId } from "../src/events.js";

const SHA = /^[0-9a-f]{40}$/;
const PR_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
const FAILURE_REASON = "A current required GitHub check failed on this exact candidate. Failed check: ";

function selectedCandidates(binding, delivery) {
  const { event, action, payload } = delivery;
  const repository = payload?.repository?.full_name;
  if (typeof repository !== "string" || repository.toLowerCase() !== binding.recipe.repository) return [];
  if (event === "pull_request" && PR_ACTIONS.has(action)) {
    return [{ number: payload.pull_request?.number, head: payload.pull_request?.head?.sha }];
  }
  if (action !== "completed" || !["check_suite", "check_run"].includes(event)) return [];
  const checks = payload[event];
  if (event === "check_run" && !binding.recipe.requiredChecks.some(check =>
    check.app === checks?.app?.slug && check.name === checks?.name)) return [];
  if (!Array.isArray(checks?.pull_requests)) return [];
  const numbers = new Set(checks.pull_requests.map(pull => pull?.number));
  return binding.pulls.filter(number => numbers.has(number)).map(number => ({ number, head: checks.head_sha }));
}

export function readGithubReviewWebhookBinding(value) {
  const recipe = readGithubReviewRecipe(value);
  if (!recipe) return null;
  const { pulls, requesterId, reviewerId, workItemId } = value;
  if (!Array.isArray(pulls) || !pulls.length || pulls.length > 20 || new Set(pulls).size !== pulls.length
    || !pulls.every(number => Number.isSafeInteger(number) && number > 0)
    || ![requesterId, reviewerId, workItemId].every(validId) || requesterId === reviewerId)
    throw new Error("Invalid GitHub review webhook binding");
  return { recipe, pulls, requesterId, reviewerId, workItemId };
}

async function readGithubJson(path, { fetchImpl, token, signal }) {
  const response = await fetchImpl(`https://api.github.com/${path}`, {
    signal, redirect: "error", headers: { Accept: "application/vnd.github+json",
      "User-Agent": "Project-Room-review-recipe", "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  if (!response.ok) throw new Error("GitHub review evidence is unavailable");
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error("GitHub review response exceeds the bounded read");
  return { value: JSON.parse(body), more: (response.headers.get("link") ?? "").includes('rel="next"') };
}

export async function observeWebhookPull(recipe, { number, head }, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = { fetchImpl, token: options.token, signal: AbortSignal.timeout(8500) };
  const pullPath = `repos/${recipe.repository}/pulls/${number}`;
  const readPull = async () => {
    const { value } = await readGithubJson(pullPath, request);
    const repository = value.base?.repo?.full_name;
    if (typeof repository !== "string" || repository.toLowerCase() !== recipe.repository || value.number !== number)
      throw new Error("GitHub review pull binding changed");
    return { repository, number, head: value.head?.sha, state: value.state, draft: value.draft, merged: value.merged };
  };
  const first = await readPull();
  if (first.head !== head) return { reason: "stale_head" };
  if (first.state !== "open" || first.draft) return { reason: first.draft ? "draft" : "closed" };
  const checks = [];
  const checkIds = new Set();
  let expectedCount;
  let more = true;
  for (let page = 1; more && page <= 4; page++) {
    const reply = await readGithubJson(`repos/${recipe.repository}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`, request);
    const { total_count: count, check_runs: rows } = reply.value ?? {};
    expectedCount ??= count;
    if (!Number.isSafeInteger(count) || count < 0 || count > 400 || count !== expectedCount || !Array.isArray(rows))
      return { reason: "incomplete_checks" };
    for (const check of rows) {
      if (check?.head_sha !== head || !Number.isSafeInteger(check.id) || check.id <= 0 || checkIds.has(check.id))
        return { reason: "incomplete_checks" };
      checkIds.add(check.id);
      checks.push({ id: check.id, app: check.app?.slug, name: check.name,
        head: check.head_sha, status: check.status, conclusion: check.conclusion });
    }
    more = reply.more;
  }
  if (more || checks.length !== expectedCount) return { reason: "incomplete_checks" };
  const verified = await readPull();
  if (Object.keys(first).some(key => first[key] !== verified[key])) return { reason: "pull_changed" };
  return { snapshot: { ...verified, checks, observedAt: Date.now() } };
}

function latestReviewOperation(store, roomId, requesterId, original) {
  // Replacement operations have a fixed-width digest after the original ID.
  // The exact prefix is indexed by the existing command journal primary key.
  return store.db.prepare(`SELECT id FROM commands WHERE room_id=? AND actor_id=?
    AND id>=? AND id<? AND length(id)=? ORDER BY sequence DESC LIMIT 1`)
    .get(roomId, requesterId, original + "-r-", original + "-r.", original.length + 27)?.id ?? original;
}

function readOpenedReview(store, binding, receipt, secret) {
  const { recipe, requesterId, reviewerId, workItemId } = binding;
  const { roomId } = recipe;
  const opening = store.db.prepare(`SELECT json_extract(body,'$.data.messageId') AS id
    FROM events WHERE room_id=? AND sequence=? AND id=?`).get(roomId, receipt.sequence, receipt.eventId);
  if (!validId(opening?.id)) throw new Error("GitHub review receipt has no opening request");
  const { request } = store.replyRequests.selected(secret, roomId, opening.id, { view: "compact" });
  if (request.openingEventId !== receipt.eventId || request.requesterId !== requesterId
      || request.recipientId !== reviewerId || request.workItemId !== workItemId)
    throw new Error("GitHub review receipt does not match the configured request");
  return request;
}

async function withdrawFailedReview(store, binding, candidate, check, operation, request, secret, observe, token) {
  const { recipe, requesterId } = binding;
  const { roomId } = recipe;
  if (request.status !== "open") return "replayed";
  const { snapshot, reason } = await observe(recipe, candidate, { token });
  if (!snapshot || snapshot.head !== candidate.head || snapshot.number !== candidate.number) return reason ?? "stale_head";
  const decision = evaluateGithubReview(recipe, snapshot);
  // A delayed failure may have been superseded. The complete current observation
  // must show this required check at the delivered attempt or a newer failure.
  const failure = decision.checks?.find(current => current.app === check.app?.slug
    && current.name === check.name && current.id >= check.id && current.status === "failed");
  if (decision.reason !== "required_check_failed" || !failure)
    return "replayed";

  const command = buildReplyCommand({ roomId, memberId: requesterId }, "room_cancel_request", {
    requestId: operation + "-withdraw",
    requestMessageId: request.id,
    expectedRequestRevision: request.revision,
    reason: FAILURE_REASON + JSON.stringify({ app: failure.app, name: failure.name, id: failure.id }),
  });
  try {
    const result = store.command(secret, roomId, command);
    return result.duplicate ? "replayed" : "withdrawn";
  } catch (error) {
    if (error?.code === "idempotency_conflict" && store.operationReceipt(secret, roomId, command.id).status === "recorded")
      return "replayed";
    if (error?.code === "command_rejected"
        && store.replyRequests.selected(secret, roomId, request.id, { view: "compact" }).request.status !== "open")
      return "replayed";
    throw error;
  }
}

async function recoverPassingReview(store, binding, candidate, check, original, operation, request, withdrawal, secret, observe, token) {
  if (request.status !== "cancelled" || request.terminalEventId !== withdrawal.eventId) return "replayed";
  const { recipe, requesterId } = binding;
  const { roomId } = recipe;
  const row = store.db.prepare(`SELECT json_extract(body,'$.data.reason') AS reason
    FROM events WHERE room_id=? AND sequence=? AND id=?`).get(roomId, withdrawal.sequence, withdrawal.eventId);
  if (!row?.reason?.startsWith(FAILURE_REASON)) return "replayed";
  const failed = JSON.parse(row.reason.slice(FAILURE_REASON.length));
  const { snapshot, reason } = await observe(recipe, candidate, { token });
  if (!snapshot || snapshot.head !== candidate.head || snapshot.number !== candidate.number) return reason ?? "stale_head";
  const decision = evaluateGithubReview(recipe, snapshot);
  const matchesAttempt = (app, name, minimum) => decision.checks?.some(row =>
    row.app === app && row.name === name && row.status === "passed" && row.id >= minimum);
  if (decision.action !== "review_ready" || !matchesAttempt(failed.app, failed.name, failed.id + 1)
      || !matchesAttempt(check.app?.slug, check.name, check.id)) return "replayed";

  const resumeId = original + "-r-" + createHash("sha256").update(withdrawal.eventId).digest("hex").slice(0, 24);
  return store.transaction(() => {
    if (latestReviewOperation(store, roomId, requesterId, original) !== operation) return "replayed";
    return postReview(store, binding, candidate, resumeId, decision, secret, request.id);
  });
}

function postReview(store, {recipe, requesterId, reviewerId, workItemId}, {head}, operation, decision, secret, previous) {
  const command = buildReplyCommand({ roomId: recipe.roomId, memberId: requesterId }, "room_request_reply", {
    requestId: operation, toMemberId: reviewerId, workItemId,
    ...(previous && { replyToId: previous }),
    body: [
      `Review the exact GitHub candidate for ${decision.pullRequest}.`,
      `Candidate revision: ${head}`,
      "Confirm that the open pull still points at this revision before reviewing. If it changed, decline this request as superseded.",
      "Independently inspect the exact diff and report what is sound, any blocking finding, and the checked head. Read-only QA only. Do not merge or deploy.",
      "Room checked these GitHub attempts before opening this request:",
      ...decision.checks.map(check => `- ${check.app} / ${check.name} / attempt ${check.id}`)
    ].join("\n")
  });
  try {
    return store.command(secret, recipe.roomId, command).duplicate ? "replayed" : "posted";
  } catch (error) {
    if (error?.code === "idempotency_conflict" && store.operationReceipt(secret, recipe.roomId, operation).status === "recorded")
      return "replayed";
    throw error;
  }
}

// The caller verifies the signature before invoking this path. A posted Room
// command is the durable deduplication record, across processes and redeliveries.
export async function dispatchGithubReview(store, binding, delivery, { credential, observe = observeWebhookPull, token } = {}) {
  if (!binding) return [];
  const { recipe, requesterId, reviewerId } = binding;
  const candidates = selectedCandidates(binding, delivery)
    .filter(({ number, head }) => binding.pulls.includes(number) && typeof head === "string" && SHA.test(head));
  if (!candidates.length) return [];
  const secret = await credential();
  if (store.authenticate(secret, recipe.roomId).member.id !== requesterId)
    throw new Error("GitHub review requester does not match the saved identity");
  const outcomes = [];
  for (const candidate of candidates) {
    const { number, head } = candidate;
    const original = `github-review-${createHash("sha256").update(JSON.stringify([
      recipe.roomId, recipe.repository, number, head, reviewerId
    ])).digest("hex")}`;
    const operation = latestReviewOperation(store, recipe.roomId, requesterId, original);
    const receipt = store.operationReceipt(secret, recipe.roomId, operation);
    if (receipt.status === "recorded") {
      const check = delivery.event === "check_run" ? delivery.payload.check_run : null;
      if (!Number.isSafeInteger(check?.id) || check.id <= 0 || typeof check.conclusion !== "string") {
        outcomes.push({ number, status: "replayed" });
        continue;
      }
      const withdrawal = check.conclusion === "success"
        ? store.operationReceipt(secret, recipe.roomId, operation + "-withdraw") : null;
      if (withdrawal && withdrawal.status !== "recorded") {
        outcomes.push({ number, status: "replayed" });
        continue;
      }
      const request = readOpenedReview(store, binding, receipt, secret);
      const status = withdrawal
        ? await recoverPassingReview(store, binding, candidate, check, original, operation, request, withdrawal, secret, observe, token)
        : await withdrawFailedReview(store, binding, candidate, check, operation, request, secret, observe, token);
      outcomes.push({ number, status });
      continue;
    }
    const { snapshot, reason } = await observe(recipe, candidate, { token });
    if (!snapshot || snapshot.head !== head || snapshot.number !== number) {
      outcomes.push({ number, status: reason ?? "stale_head" });
      continue;
    }
    const decision = evaluateGithubReview(recipe, snapshot);
    if (decision.action !== "review_ready") {
      outcomes.push({ number, status: decision.reason });
      continue;
    }
    outcomes.push({ number, status: postReview(store, binding, candidate, operation, decision, secret) });
  }
  return outcomes;
}

export async function maybeDispatchGithubReview(store, delivery, env) {
  if (!env.ROOM_GITHUB_REVIEW_RECIPE) return [];
  const binding = readGithubReviewWebhookBinding(JSON.parse(env.ROOM_GITHUB_REVIEW_RECIPE));
  return dispatchGithubReview(store, binding, delivery, {
    token: env.GH_TOKEN || env.GITHUB_TOKEN,
    async credential() {
      const { readPrivateJson } = await import("../room-acp/src/private-files.mjs");
      const value = readPrivateJson(env.ROOM_GITHUB_REVIEW_CREDENTIAL_PATH);
      return value.identitySecret ?? value.token;
    }
  });
}
