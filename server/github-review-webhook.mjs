import { githubWorkAttachment, readGithubWorkRecord, updateGithubWorkObservation, writeGithubWorkRecord } from "./github-work-attachment.mjs";
import { createHash } from "node:crypto";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { evaluateGithubReview, readGithubReviewRecipe } from "../client/github-review-recipe.mjs";
import { validId } from "../src/events.js";

const SHA = /^[0-9a-f]{40}$/;
const PR_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
const FAILURE_REASON = "A current required GitHub check failed on this exact candidate. Failed check: ";

function selectedCandidates(binding, delivery, attached = false) {
  const { event, action, payload } = delivery;
  const repository = payload?.repository?.full_name;
  if (typeof repository !== "string" || repository.toLowerCase() !== binding.recipe.repository) return [];
  if (event === "pull_request" && (PR_ACTIONS.has(action) || attached && ["closed", "converted_to_draft"].includes(action))) {
    return [{ number: payload.pull_request?.number, head: payload.pull_request?.head?.sha }];
  }
  if (attached && event === "pull_request_review" && binding.correctionReviewerIds.length
      && ["submitted", "dismissed"].includes(action)) {
    return [{ number: payload.pull_request?.number, head: payload.pull_request?.head?.sha }];
  }
  if (action !== "completed" || !["check_suite", "check_run"].includes(event)) return [];
  const checks = payload[event];
  if (event === "check_run" && !binding.recipe.requiredChecks.some(check =>
    check.app === checks?.app?.slug && check.name === checks?.name)) return [];
  if (!Array.isArray(checks?.pull_requests)) return [];
  const numbers = new Set(checks.pull_requests.map(pull => pull?.number));
  return [...numbers].filter(number => attached || binding.pulls.includes(number)).map(number => ({ number, head: checks.head_sha }));
}

export function readGithubReviewWebhookBinding(value) {
  const recipe = readGithubReviewRecipe(value);
  if (!recipe) return null;
  const { pulls = [], requesterId, reviewerId, workItemId, correctionReviewerIds = [] } = value;
  if (!Array.isArray(pulls) || pulls.length > 20 || new Set(pulls).size !== pulls.length
    || !pulls.every(number => Number.isSafeInteger(number) && number > 0)
    || !Array.isArray(correctionReviewerIds) || correctionReviewerIds.length > 10
    || !correctionReviewerIds.every(id => Number.isSafeInteger(id) && id > 0)
    || ![requesterId, reviewerId, workItemId].every(validId) || requesterId === reviewerId)
    throw new Error("Invalid GitHub review webhook binding");
  return { recipe, pulls, requesterId, reviewerId, workItemId, correctionReviewerIds };
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
    return { repository: repository.toLowerCase(), number, head: value.head?.sha, state: value.state, draft: value.draft, merged: value.merged };
  };
  const first = await readPull();
  if (first.head !== head) return { reason: "stale_head" };
  if (first.state !== "open" || first.draft) {
    if (options.includeInactive) return { snapshot: { ...first, checks: [], observedAt: Date.now() } };
    return { reason: first.draft ? "draft" : "closed" };
  }
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
  const trusted = new Set(options.correctionReviewerIds ?? []);
  const corrections = new Map();
  if (trusted.size) {
    let remaining = true;
    for (let page = 1; remaining && page <= 4; page++) {
      const reply = await readGithubJson(pullPath + `/reviews?per_page=100&page=${page}`, request);
      if (!Array.isArray(reply.value)) return { reason: "incomplete_reviews" };
      for (const review of reply.value) {
        if (!trusted.has(review.user?.id) || !Number.isSafeInteger(review.id) || review.id <= 0) continue;
        if (["APPROVED", "DISMISSED", "CHANGES_REQUESTED"].includes(review.state))
          corrections.set(review.user.id, review);
      }
      remaining = reply.more;
    }
    if (remaining) return { reason: "incomplete_reviews" };
  }
  const correctionIds = [...corrections.values()].filter(review => review.state === "CHANGES_REQUESTED" && review.commit_id === head)
    .map(review => review.id).sort((a, b) => a - b);
  const verified = await readPull();
  if (Object.keys(first).some(key => first[key] !== verified[key])) return { reason: "pull_changed" };
  return { snapshot: { ...verified, checks, correctionIds, observedAt: Date.now() } };
}

function reviewId(recipe, number, head, reviewerId) {
  return `github-review-${createHash("sha256").update(JSON.stringify([
    recipe.roomId, recipe.repository, number, head, reviewerId
  ])).digest("hex")}`;
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
      || (check && !matchesAttempt(check.app?.slug, check.name, check.id))) return "replayed";

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
    const original = reviewId(recipe, number, head, reviewerId);
    const operation = latestReviewOperation(store, recipe.roomId, requesterId, original);
    const receipt = store.operationReceipt(secret, recipe.roomId, operation);
    if (receipt.status === "recorded") {
      const check = delivery.event === "check_run" ? delivery.payload.check_run : null;
      const passedSuite = delivery.event === "check_suite" && delivery.payload.check_suite?.conclusion === "success"
        && recipe.requiredChecks.some(required => required.app === delivery.payload.check_suite?.app?.slug);
      if (!passedSuite && (!Number.isSafeInteger(check?.id) || check.id <= 0 || typeof check.conclusion !== "string")) {
        outcomes.push({ number, status: "replayed" });
        continue;
      }
      // A final suite completion can recover a check_run callback that arrived
      // before the authoritative list caught up. It cannot withdraw a review:
      // a suite by itself does not identify a failed required check.
      const withdrawal = passedSuite || check.conclusion === "success"
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

const inboxPrefix = "_github-work-pending:";
const drains = new WeakMap();

function workWebhookOptions(env) {
  return { token: env.GH_TOKEN || env.GITHUB_TOKEN,
    async credential() {
      const { readPrivateJson } = await import("../room-acp/src/private-files.mjs");
      const value = readPrivateJson(env.ROOM_GITHUB_REVIEW_CREDENTIAL_PATH);
      return value.identitySecret ?? value.token;
    } };
}

export function saveAttachedGithubDelivery(store, binding, delivery) {
  if (!binding || typeof delivery.delivery !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery.delivery)) return [];
  const { recipe } = binding;
  const candidates = selectedCandidates(binding, delivery, true).filter(({ number, head }) =>
    Number.isSafeInteger(number) && number > 0 && SHA.test(head ?? "")
    && githubWorkAttachment(store, recipe.roomId, recipe.repository, number));
  if (!candidates.length) return [];
  return store.transaction(() => candidates.map(candidate => {
    const key = inboxPrefix + recipe.roomId + ":" + recipe.repository + ":" + delivery.delivery + ":" + candidate.number;
    if (!readGithubWorkRecord(store, key)) {
      const { event, action } = delivery;
      const original = delivery.payload[event];
      const payload = { repository: { full_name: recipe.repository } };
      if (event === "pull_request" || event === "pull_request_review") payload.pull_request = { number: candidate.number, head: { sha: candidate.head } };
      else payload[event] = { id: original.id, name: original.name, conclusion: original.conclusion, app: { slug: original.app?.slug },
        head_sha: candidate.head, pull_requests: [{ number: candidate.number }] };
      writeGithubWorkRecord(store, key, { candidate, delivery: { event, action, payload } });
    }
    return candidate.number;
  }));
}

export async function reconcileAttachedGithubDelivery(store, binding, entry, options) {
  const { recipe, requesterId, reviewerId } = binding;
  const { number, head } = entry.candidate;
  const linked = githubWorkAttachment(store, recipe.roomId, recipe.repository, number);
  if (!linked) return;
  const observe = options.observe ?? observeWebhookPull;
  const observed = await observe(recipe, entry.candidate, { token: options.token, includeInactive: true, correctionReviewerIds: binding.correctionReviewerIds });
  if (!observed.snapshot) {
    // A stale event is a routing hint only; uncertainty remains recoverable.
    if (observed.reason === "stale_head") return;
    throw new Error("Current GitHub PR evidence could not be verified.");
  }
  const target = { ...binding, pulls: [number], workItemId: linked.workItemId };
  const secret = await options.credential();
  if (store.authenticate(secret, recipe.roomId).member.id !== requesterId)
    throw new Error("GitHub review requester does not match the saved identity");
  store.workContext(secret, recipe.roomId, linked.workItemId);
  const decision = evaluateGithubReview(recipe, observed.snapshot);
  const inactive = observed.snapshot.state !== "open" || observed.snapshot.draft;
  const correction = linked.observedHead !== head || inactive;
  const original = reviewId(recipe, number, linked.observedHead, reviewerId);
  const diagnosis = reviewId(recipe, number, head, reviewerId) + "-ci";
  const cancel = (operation, reason, suffix, recipient = target) => {
    const prior = store.operationReceipt(secret, recipe.roomId, operation);
    if (prior.status !== "recorded") return;
    const request = readOpenedReview(store, recipient, prior, secret);
    if (request.status !== "open") return;
    const command = buildReplyCommand({ roomId: recipe.roomId, memberId: requesterId }, "room_cancel_request", {
      requestId: operation + suffix, requestMessageId: request.id, expectedRequestRevision: request.revision, reason
    });
    store.command(secret, recipe.roomId, command);
  };
  const resume = store.transaction(() => {
    if (correction) {
      const reason = "GitHub changed the candidate or the pull request is no longer ready.";
      cancel(latestReviewOperation(store, recipe.roomId, requesterId, original), reason, "-stale");
      cancel(original + "-ci", reason, "-stale");
    }
    const reviews = inactive ? [] : observed.snapshot.correctionIds ?? [];
    const correctionLinks = reviews.map(id => decision.pullRequest + "#pullrequestreview-" + id);
    const recipient = { ...target, reviewerId: linked.producerId };
    const feedbackOperation = (sha, ids) => reviewId(recipe, number, sha, linked.producerId) + "-fix-"
      + createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 16);
    const priorFeedback = linked.next?.correctionIds ?? [];
    if (priorFeedback.length && (correction || JSON.stringify(priorFeedback) !== JSON.stringify(reviews))) {
      cancel(feedbackOperation(linked.observedHead, priorFeedback), "The GitHub correction changed or was resolved.", "-end", recipient);
    }
    if (reviews.length) {
      const current = reviewId(recipe, number, head, reviewerId);
      cancel(latestReviewOperation(store, recipe.roomId, requesterId, current),
        "A trusted GitHub review requested changes on this candidate.", "-feedback");
      cancel(diagnosis, "The candidate is awaiting a GitHub review correction.", "-feedback");
      const operation = feedbackOperation(head, reviews);
      if (linked.producerId && linked.producerId !== requesterId
        && store.operationReceipt(secret, recipe.roomId, operation).status !== "recorded") {
        store.command(secret, recipe.roomId, buildReplyCommand({ roomId: recipe.roomId, memberId: requesterId }, "room_request_reply", {
          requestId: operation, toMemberId: linked.producerId, workItemId: linked.workItemId,
          body: [
            `Review the requested GitHub changes on ${decision.pullRequest} at ${head}.`,
            ...correctionLinks,
            "Verify the current head and review state, then report the smallest justified change and its evidence.",
            "Follow the existing Work Thread write scope. This request grants no new permissions."
          ].join("\n")
        }));
      }
      updateGithubWorkObservation(store, recipe.roomId, recipe.repository, number, { ...observed.snapshot,
        next: { reason: "github_changes_requested", correctionIds: reviews, correctionLinks, checks: decision.checks } });
      return null;
    }
    const failure = decision.checks?.find(check => check.status === "failed");
    if (!inactive && failure) {
      const current = reviewId(recipe, number, head, reviewerId);
      const operation = latestReviewOperation(store, recipe.roomId, requesterId, current);
      cancel(operation, FAILURE_REASON + JSON.stringify({ app: failure.app, name: failure.name, id: failure.id }), "-withdraw");
      if (store.operationReceipt(secret, recipe.roomId, diagnosis).status !== "recorded") {
        store.command(secret, recipe.roomId, buildReplyCommand({ roomId: recipe.roomId, memberId: requesterId }, "room_request_reply", {
          requestId: diagnosis, toMemberId: reviewerId, workItemId: linked.workItemId,
          body: [
            `Diagnose the required GitHub check on ${decision.pullRequest} at ${head}.`,
            `Exact check: ${failure.app} / ${failure.name} / attempt ${failure.id}.`,
            "Confirm the current PR head and check attempt. Compare the failing job and test signatures with equivalent base evidence.",
            "Report candidate-specific, matching base failure, or unknown, with links and the smallest next action.",
            "If the candidate or check has changed, report the request as superseded. Read-only QA. Do not push, rerun checks, merge, or deploy."
          ].join("\n")
        }));
      }
    }
    if (!inactive && decision.action === "review_ready") {
      cancel(diagnosis, "The exact candidate now has passing required checks.", "-passed");
      const current = reviewId(recipe, number, head, reviewerId);
      const operation = latestReviewOperation(store, recipe.roomId, requesterId, current);
      const receipt = store.operationReceipt(secret, recipe.roomId, operation);
      if (receipt.status !== "recorded") {
        postReview(store, target, entry.candidate, current, decision, secret);
      } else {
        const withdrawal = store.operationReceipt(secret, recipe.roomId, operation + "-withdraw");
        const request = readOpenedReview(store, target, receipt, secret);
        for (const suffix of ["-feedback", "-stale"]) {
          const cancelled = store.operationReceipt(secret, recipe.roomId, operation + suffix);
          if (cancelled.status === "recorded" && request.status === "cancelled" && request.terminalEventId === cancelled.eventId) {
            const resumed = current + "-r-" + createHash("sha256").update(cancelled.eventId).digest("hex").slice(0, 24);
            postReview(store, target, entry.candidate, resumed, decision, secret, request.id);
          }
        }
        if (withdrawal.status === "recorded") {
          // This function reads GitHub through the immutable observation supplied here.
          // Awaiting it after the transaction keeps the store transaction synchronous.
          return { request, withdrawal, operation, current };
        }
      }
    }
    updateGithubWorkObservation(store, recipe.roomId, recipe.repository, number, { ...observed.snapshot,
      next: { reason: decision.reason, ...(decision.checks ? { checks: decision.checks } : {}) } });
    return null;
  });

  if (resume) {
    // The command journal ensures both the check withdrawal and its replacement
    // retain their exact revisions across an interrupted delivery.
    const { request, withdrawal, operation, current } = resume;
    await recoverPassingReview(store, target, entry.candidate, null, current, operation, request,
      withdrawal, secret, async () => observed, options.token);
    updateGithubWorkObservation(store, recipe.roomId, recipe.repository, number, { ...observed.snapshot,
      next: { reason: decision.reason, checks: decision.checks } });
  }
}

export function drainAttachedGithubDeliveries(store, binding, options) {
  if (!binding) return Promise.resolve([]);
  const current = drains.get(store);
  if (current) {
    current.again = true;
    return current.task;
  }
  const drain = { again: false };
  const run = async () => {
    const { roomId, repository } = binding.recipe;
    const prefix = inboxPrefix + roomId + ":" + repository + ":";
    const rows = store.db.prepare(`SELECT room_id,config_json FROM work_claim_config
      WHERE room_id>=? AND room_id<? AND room_id>? ORDER BY room_id LIMIT 32`);
    const outcomes = [];
    const attempted = new Set();
    do {
      drain.again = false;
      let cursor = prefix, page;
      do {
        page = rows.all(prefix, prefix.slice(0, -1) + ";", cursor);
        for (const row of page) {
          cursor = row.room_id;
          if (attempted.has(cursor)) continue;
          attempted.add(cursor);
          try {
            await reconcileAttachedGithubDelivery(store, binding, JSON.parse(row.config_json), options);
            store.transaction(() => store.db.prepare("DELETE FROM work_claim_config WHERE room_id=? AND config_json=?")
              .run(row.room_id, row.config_json));
            outcomes.push({ status: "observed" });
          } catch (error) {
            options.onPending?.(error);
            outcomes.push({ status: "pending" });
          }
        }
      } while (page.length === 32);
    } while (drain.again);
    return outcomes;
  };
  drain.task = Promise.resolve().then(run).finally(() => drains.delete(store));
  drains.set(store, drain);
  return drain.task;
}

export function recoverAttachedGithubWork(store, env = process.env) {
  if (!env.ROOM_GITHUB_REVIEW_RECIPE) return Promise.resolve([]);
  const binding = readGithubReviewWebhookBinding(JSON.parse(env.ROOM_GITHUB_REVIEW_RECIPE));
  return drainAttachedGithubDeliveries(store, binding, workWebhookOptions(env));
}

export function queueAttachedGithubReview(store, delivery, env) {
  if (!env.ROOM_GITHUB_REVIEW_RECIPE) return [];
  const binding = readGithubReviewWebhookBinding(JSON.parse(env.ROOM_GITHUB_REVIEW_RECIPE));
  const queued = saveAttachedGithubDelivery(store, binding, delivery);
  if (queued.length) setImmediate(() => { void drainAttachedGithubDeliveries(store, binding, workWebhookOptions(env)).catch(() => {}); });
  return queued;
}

export async function maybeDispatchGithubReview(store, delivery, env) {
  if (!env.ROOM_GITHUB_REVIEW_RECIPE) return [];
  const binding = readGithubReviewWebhookBinding(JSON.parse(env.ROOM_GITHUB_REVIEW_RECIPE));
  return dispatchGithubReview(store, binding, delivery, workWebhookOptions(env));
}
