// Adapted from Block Buzz App's GitHub watch step, Apache-2.0.
// Upstream 5a21469faa8c53d20105d58c592a48f68c6dcf7c, src/bundled/github/watch.ts.
// Room uses explicit required checks and exact-head offers in place of merge advice and timed wakes.
import { createHash } from "node:crypto";
import { validId } from "../src/events.js";

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/i;
const integer = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checkKey = ({ app, name }) => JSON.stringify([app, name]);
const checkName = ({ app, name }) => typeof app === "string" && /^[a-z0-9-]{1,100}$/.test(app)
  && typeof name === "string" && name.trim().length > 0 && name.length <= 200;

export function readGithubReviewRecipe(input) {
  if (input == null || input.enabled === false) return null;
  if (input.enabled !== true || input.version !== 1 || !validId(input.roomId)
    || typeof input.repository !== "string" || !REPO.test(input.repository)
    || !Array.isArray(input.requiredChecks) || !input.requiredChecks.length || input.requiredChecks.length > 30
    || !input.requiredChecks.every(check => check && checkName(check))) throw new Error("Invalid GitHub review recipe");
  const requiredChecks = input.requiredChecks.map(({ app, name }) => ({ app, name }));
  if (new Set(requiredChecks.map(checkKey)).size !== requiredChecks.length) throw new Error("Duplicate required check");
  requiredChecks.sort((a, b) => checkKey(a).localeCompare(checkKey(b), "en"));
  const policy = { version: 1, roomId: input.roomId, repository: input.repository.toLowerCase(), requiredChecks };
  return { ...policy, id: hash(policy) };
}

function exactChecks(snapshot, requiredChecks) {
  const wanted = new Set(requiredChecks.map(checkKey));
  const latest = new Map();
  for (const check of snapshot.checks) {
    if (check?.head !== snapshot.head || !checkName(check) || !integer(check.id)) continue;
    const key = checkKey(check);
    if (!wanted.has(key)) continue;
    const prior = latest.get(key);
    if (!prior || check.id > prior.id) latest.set(key, check);
  }
  return requiredChecks.map(required => {
    const current = latest.get(checkKey(required));
    return { ...required, id: current?.id ?? null, status: !current ? "missing" : current.status !== "completed"
      ? "pending" : current.conclusion === "success" ? "passed" : "failed", conclusion: current?.conclusion ?? null };
  });
}

export function evaluateGithubReview(recipe, snapshot, checkpoint = null) {
  if (!recipe) return { action: "disabled" };
  if (typeof snapshot?.repository !== "string" || snapshot.repository.toLowerCase() !== recipe.repository)
    return { action: "ignored", reason: "different_repository" };
  if (!integer(snapshot.number) || typeof snapshot.head !== "string" || !SHA.test(snapshot.head)
    || !["open", "closed"].includes(snapshot.state) || typeof snapshot.draft !== "boolean"
    || typeof snapshot.merged !== "boolean" || !integer(snapshot.observedAt)
    || !Array.isArray(snapshot.checks) || snapshot.checks.length > 3000)
    throw new Error("Invalid GitHub pull request observation");

  const binding = { recipeId: recipe.id, roomId: recipe.roomId, repository: recipe.repository, number: snapshot.number };
  if (checkpoint && Object.keys(binding).some(key => checkpoint[key] !== binding[key]))
    throw new Error("Checkpoint belongs to a different room, recipe or pull request");
  if (checkpoint && snapshot.observedAt <= checkpoint.observedAt)
    return { action: "unchanged", reason: "observation_already_seen", checkpoint };

  if (checkpoint && (!SHA.test(checkpoint.head ?? "") || !integer(checkpoint.observedAt)
    || !Array.isArray(checkpoint.checks) || checkpoint.checks.length !== recipe.requiredChecks.length))
    throw new Error("Invalid GitHub review checkpoint");

  const checks = exactChecks(snapshot, recipe.requiredChecks);
  const headChanged = Boolean(checkpoint && checkpoint.head !== snapshot.head);
  if (checkpoint && !headChanged && snapshot.state === "open" && !snapshot.draft
    && checks.some((check, index) => check.id !== null && checkpoint.checks[index]?.id > check.id))
    return { action: "unchanged", reason: "older_check_attempt", checkpoint };

  const ready = snapshot.state === "open" && !snapshot.draft && checks.every(check => check.status === "passed");
  const evidenceKey = hash([binding, snapshot.head, checks.map(check => check.id)]);
  const offerId = ready ? `github-review-${evidenceKey}` : null;
  const next = { ...binding, observedAt: snapshot.observedAt, head: snapshot.head, checks, offerId,
    lastOfferedHead: ready ? snapshot.head : checkpoint?.lastOfferedHead ?? null };
  const withdrawOfferId = checkpoint?.offerId && checkpoint.offerId !== offerId ? checkpoint.offerId : null;
  const base = { roomId: recipe.roomId, pullRequest: `https://github.com/${recipe.repository}/pull/${snapshot.number}`,
    head: snapshot.head, headChanged, checks, withdrawOfferId, checkpoint: next };
  if (ready && offerId !== checkpoint?.offerId)
    return { ...base, action: "review_ready", reason: checkpoint?.lastOfferedHead === snapshot.head ? "checks_rerun" : "exact_head_checks_passed", offerId };
  if (ready) return { ...base, action: "unchanged", reason: "offer_already_exists", offerId };
  return { ...base, action: "hold", reason: snapshot.state === "closed" ? (snapshot.merged ? "merged" : "closed")
    : snapshot.draft ? "draft" : checks.some(check => check.status === "failed") ? "required_check_failed" : "required_check_pending" };
}
