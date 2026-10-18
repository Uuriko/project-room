// Tasks › Board. Claims come from GET /work-claims. Live updates follow
// work_claim.updated on the room snapshot the client already applies.
// This module does not open its own stream and does not poll.

import { needsMeHtml } from "./board-mine.js";
import { uiText } from "./strings.js";

const TEN_MINUTES = 10 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const COLUMNS = Object.freeze([
  ["ready", "Ready"],
  ["claimed", "Claimed / In progress"],
  ["blocked", "Blocked"],
  ["review", "In review"],
  ["landed", "Landed"]
]);

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
}

function updatedAt(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  const stamped = history.length && typeof history[history.length - 1]?.at === "string" ? history[history.length - 1].at : "";
  const stored = typeof item?.updatedAt === "string" ? item.updatedAt : "";
  return stamped > stored ? stamped : (stored || stamped);
}

function openPull(item) {
  return Boolean(item?.pullRequest?.url) && !item.pullRequest.outcome;
}

function pullNumber(url) {
  const match = /\/pull\/([1-9]\d{0,9})$/.exec(String(url ?? ""));
  return match ? match[1] : "";
}

// Protocol/host allowlist for claim PR links: only canonical
// https://github.com/{owner}/{repo}/pull/{number} URLs become anchors.
// The server write path already canonicalizes to this shape, so this is
// defense in depth against any render path that never crossed the server.
function safePrUrl(url) {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/.test(String(url ?? "")) ? url : null;
}

function dependenciesMet(item, byId) {
  const deps = Array.isArray(item?.dependsOn) ? item.dependsOn : [];
  return deps.every(id => byId.get(id)?.state === "done");
}

export function columnOf(item, byId, now) {
  if (!item) return null;
  if (item.state === "done") {
    const at = Date.parse(updatedAt(item));
    return Number.isFinite(at) && now - at <= WEEK ? "landed" : null;
  }
  if (item.state === "unclaimed" && !item.owner && !dependenciesMet(item, byId)) return "blocked";
  if (item.state === "delivered" || openPull(item)) return "review";
  if (item.state === "blocked") return "blocked";
  if (item.state === "claimed" || item.state === "in_progress") return "claimed";
  if (item.state === "unclaimed" && !item.owner && dependenciesMet(item, byId)) return "ready";
  return null;
}

export function placeClaims(items, now = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.map(item => [item.id, item]));
  const columns = Object.fromEntries(COLUMNS.map(([id]) => [id, []]));
  for (const item of list) {
    const column = columnOf(item, byId, now);
    if (column) columns[column].push(item);
  }
  for (const rows of Object.values(columns)) rows.sort((a, b) => String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
  return columns;
}

function memberName(members, id) {
  if (!id) return "";
  const member = members?.[id];
  const name = String(member?.displayName ?? id).trim() || id;
  if (member?.kind === "agent" && !name.startsWith("@")) return `@${name}`;
  return name;
}

// Board search and "mine only" filter. Pure: the filter bar narrows the loaded
// claims client-side, and the two controls compose by AND — each control can
// only narrow the other, never widen it.
export function filterClaims(items, { q = "", mine = false } = {}, viewerId = null, members = {}) {
  const term = String(q ?? "").trim().toLocaleLowerCase();
  const list = Array.isArray(items) ? items : [];
  return list.filter(item => {
    if (mine && (!viewerId || item?.owner !== viewerId)) return false;
    if (!term) return true;
    const haystack = [
      item?.title, item?.note, typeof item?.id === "string" ? item.id : "",
      item?.owner ? memberName(members, item.owner) : "Unclaimed",
      ...(Array.isArray(item?.files) ? item.files : []),
    ].filter(text => typeof text === "string");
    return haystack.some(text => text.toLocaleLowerCase().includes(term));
  });
}

export function filterActive(filter) {
  return Boolean(String(filter?.q ?? "").trim()) || Boolean(filter?.mine);
}

// The honest empty note for an active filter: it blames the filter, never the
// board's contents. Returns "" when the filter is inactive or matches something.
export function filterEmptyCopy(filter, matched) {
  if (!filterActive(filter) || matched > 0) return "";
  const query = String(filter?.q ?? "").trim();
  const sentence = uiText("board.filter.empty", { query: query ? ` “${escapeHtml(query)}”` : "" });
  return `<p class="form-hint board-filter-empty" role="status">${sentence}</p>`;
}

function initials(name) {
  const parts = String(name).replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`;
  return (letters || "?").toUpperCase();
}

function leasePhrase(event) {
  const exp = Date.parse(event?.data?.leaseExpiresAt ?? "");
  const at = Date.parse(event?.at ?? "");
  if (!Number.isFinite(exp) || !Number.isFinite(at) || exp <= at) return "";
  const hours = Math.max(1, Math.round((exp - at) / 3600000));
  return `lease ${hours}h`;
}

function countdown(iso, now) {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Lease ended";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 48) return `Lease ${Math.round(hours / 24)}d`;
  if (hours >= 1) return `Lease ${hours}h ${minutes}m`;
  return `Lease ${Math.max(1, minutes)}m`;
}

export function claimUpdateText(event, members) {
  const data = event?.data ?? {};
  const name = memberName(members, event?.actorId) || "Someone";
  const title = String(data.title || data.workClaim || "a claim");
  if (data.reason === "ci_changed" || data.action === "ci_changed") {
    const word = { success: "passed", failure: "failed", pending: "is pending", neutral: "finished" }[data.ciState] ?? "changed";
    return `CI ${word} on ${title}`;
  }
  if (data.verdict === "approve" || (data.action === "reviewed" && data.reason === "reviewed" && data.verdict === "approve")) return `${name} approved`;
  if (data.verdict === "changes_requested") return `${name} requested changes`;
  if (data.verdict === "comment") return `${name} commented`;
  if (data.action === "reviewed" && data.reason === "reviewed") return `${name} reviewed ${title}`;
  const paths = Array.isArray(data.paths) ? data.paths : [];
  if (data.action === "claimed") {
    const bits = [`${name} claimed ${title}`];
    if (paths.length) bits.push(`${paths.length} file${paths.length === 1 ? "" : "s"}`);
    const lease = leasePhrase(event);
    if (lease) bits.push(lease);
    return bits.join(" · ");
  }
  if (data.action === "created") return `${name} opened ${title}`;
  if (data.action === "released" || data.action === "lease_expired") return `${name} released ${title}`;
  if (data.action === "renewed") return `${name} renewed ${title}`;
  if (data.action === "reassigned") return `${name} reassigned ${title}`;
  if (data.action === "pr_merged") return `${name} merged ${title}`;
  if (data.action === "pr_closed") return `${name} closed the pull request on ${title}`;
  if (data.action === "state_changed") return `${name} marked ${title} ${String(data.claimState ?? "").replaceAll("_", " ")}`;
  return `${name} updated ${title}`;
}

export function collapseClaimUpdates(events) {
  const rows = (Array.isArray(events) ? events : [])
    .filter(event => event?.type === "work_claim.updated" && event.data?.workClaim)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  for (const event of rows) {
    const at = Date.parse(event.at);
    const last = groups[groups.length - 1];
    const same = last && last.claimId === event.data.workClaim && Number.isFinite(at) && at - last.start < TEN_MINUTES;
    if (same) last.event = event;
    else groups.push({ claimId: event.data.workClaim, event, start: Number.isFinite(at) ? at : 0 });
  }
  return groups;
}

export function paintClaimChat(state, list) {
  if (!list) return;
  list.querySelectorAll("[data-claim-update]").forEach(node => node.remove());
  if (!state) return;
  const groups = collapseClaimUpdates(state.eventLog);
  if (!groups.length) return;
  // One pass over the room's messages: a find() per rendered message was
  // quadratic and ran on every chat render.
  const createdAt = new Map();
  for (const message of state.messages ?? []) createdAt.set(message.id, message.createdAt);
  const stamps = [...list.querySelectorAll(":scope > .message")].map(node => ({ node, at: createdAt.get(node.dataset.messageRecordId) ?? "" }));
  for (const group of groups) {
    const line = document.createElement("li");
    line.className = "claim-update";
    line.dataset.claimUpdate = group.claimId;
    line.textContent = claimUpdateText(group.event, state.members);
    const after = stamps.find(entry => entry.at > (group.event.at ?? ""));
    list.insertBefore(line, after?.node ?? null);
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;
function liveLabel(status) {
  // The server sends behind = 0 when live and main match and null otherwise,
  // never a count, so a known mismatch has to be read from the two shas. A
  // held (stale) read can lag a fresh deploy, so it stays unknown.
  if (status && status.behind === 0) return "Live matches main";
  if (status && typeof status.behind === "number" && status.behind > 0) return "Live is behind main";
  if (status && !status.stale && FULL_SHA.test(status.live ?? "") && FULL_SHA.test(status.main ?? "") && status.live !== status.main) return uiText("board.live.differs");
  return "Deploy status unknown";
}

// room_read_board / room_acquire_claim / room_renew_claim / room_release_claim
// read the older work-item model. They are not tools for this Board.
const NOT_BOARD_TOOLS = new Set(["room_read_board", "room_acquire_claim", "room_renew_claim", "room_release_claim"]);

export function boardToolNames(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  const names = [];
  for (const name of list) {
    if (typeof name !== "string" || NOT_BOARD_TOOLS.has(name)) continue;
    if (!/work[_-]claim/.test(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

export function emptyBoardCopy(capabilities, { canWrite = true, signedIn = false } = {}) {
  // S1: a non-writer used to see the same "Claim work here" line with no form
  // and no next step. Give them their actual options instead.
  if (!canWrite) {
    return signedIn
      ? "No work posted yet. You can browse the board, but you don't have posting rights here — ask the room owner for access to post work."
      : "No work posted yet. You can browse the board — sign in to post work here.";
  }
  const tools = boardToolNames(capabilities);
  const line = "Claim work here so people and agents don't collide.";
  return tools.length ? `${line} Agents can use ${tools.join(", ")}.` : line;
}

function advertisedCapabilities(state) {
  const names = [];
  for (const member of Object.values(state?.members ?? {})) {
    if (Array.isArray(member?.capabilities)) names.push(...member.capabilities);
  }
  return names;
}

export function canWriteClaims(state, session) {
  const id = session?.member?.id;
  if (!id || !state?.members) return false;
  const ownerId = state.room?.ownerId;
  const enforced = typeof ownerId === "string" && ownerId.length > 0;
  if (!enforced) return true;
  if (id === ownerId) return true;
  const member = state.members[id];
  if (!member || member.active === false) return false;
  const permissions = new Set(member.permissions ?? []);
  if (member.kind === "human") return permissions.has("accept_work") || permissions.has("complete_work");
  const holds = (...needed) => needed.every(name => permissions.has(name));
  return holds("accept_work", "complete_work") || permissions.has("verify") || holds("steer", "accept_work", "complete_work", "verify");
}

function viewerOf(state, session) {
  const id = session?.member?.id ?? null;
  const member = id ? state?.members?.[id] : null;
  const manage = Boolean(id && (state?.room?.ownerId === id || (member?.permissions ?? []).includes("manage_claims")));
  return { id, manage, owner: Boolean(id && state?.room?.ownerId === id), write: canWriteClaims(state, session) };
}

// VERIFY step: who may record a verdict review from the board. Mirrors the
// server's mayReviewWorkClaims (an active member with write rights or the
// verify permission); the owner can never review their own claim, and only
// owned claims the kernel can still review are offered the form. The
// review route re-checks on POST; this only decides whether the form renders.
export function canReviewClaim(item, viewer, members) {
  if (!item || !viewer?.id) return false;
  const member = members?.[viewer.id];
  if (!member || member.active === false) return false;
  if (!item.owner || item.owner === viewer.id) return false;
  // recordReview accepts active or delivered claims ("only active or
  // delivered claims can be reviewed") — the delivered state is where the
  // verdict matters most, so it renders the form too. Done/closed claims
  // must not render a form the server will always reject.
  if (!["claimed", "in_progress", "blocked", "delivered"].includes(item.state)) return false;
  const permissions = new Set(member.permissions ?? []);
  return viewer.write || permissions.has("verify");
}

// Whether a review's basis still matches the claim it was recorded against.
// Mirrors the kernel's currentReviewBasis (work-claims.mjs): the owner round,
// revision and CI head must match, and — since #3684 — so must the delivery:
// an approval bound to a delivery digest counts only for that delivery, and
// an approval recorded before any delivery (generation 0) counts only for
// the round's first delivery; a re-delivery stales it like a head move.
function basisCurrent(review, item) {
  const basis = review?.basis;
  if (!basis || basis.version !== 1) return false;
  const deliveryCurrent = basis.deliveryDigest !== null && basis.deliveryDigest !== undefined
    ? basis.deliveryDigest === (item.delivery?.digest ?? null)
    : (basis.deliveryGeneration ?? 0) === 0 && (item.deliveryGeneration ?? 0) <= 1;
  return deliveryCurrent && basis.owner === item.owner && basis.claimedAt === item.claimedAt
    && basis.revision === (item.revision ?? null) && basis.headSha === (item.ci?.headSha ?? null);
}

// The member's approval that can still close this claim, or null. The
// kernel's canCloseWork additionally requires the attestation recordReview
// stamps alongside an approve verdict, at the same instant; the routes
// re-check all of it on POST — this only decides whether the board offers
// the verify control.
export function currentApprovalFor(item, memberId) {
  if (!item || typeof memberId !== "string" || !memberId) return null;
  const review = (item.reviews ?? []).find(entry => entry?.memberId === memberId && entry?.verdict === "approve");
  if (!review || !basisCurrent(review, item)) return null;
  const attested = (item.attestations ?? []).some(entry => entry?.memberId === memberId && entry.at === review.at);
  return attested ? review : null;
}

// Whether the board offers Verify on a delivered claim — policy-aware,
// mirroring canCloseWork (the route re-checks on POST):
// - self_attested (#3887): the OWNER is the verifier (reviewerId ===
//   owner) and can never hold an approval on their own claim, so the
//   approval-gated condition was unsatisfiable for exactly the person
//   the kernel authorizes; the owner gets the control, nobody else does.
// - reviewed policies: the viewer must hold a current approval, and
//   under independent_principal (#3885) must additionally hold the
//   verify permission (canCloseWork's verifyMembers) — approvers
//   without it were offered a Verify the kernel always refuses.
export function canVerifyFromBoard(item, viewer, members, roomPolicy = null) {
  if (!item || item.state !== "delivered" || !viewer?.id) return false;
  const policy = item.reviewPolicy ?? roomPolicy ?? "self_attested";
  if (policy === "self_attested") return item.owner === viewer.id;
  if (item.owner === viewer.id) return false;
  if (!currentApprovalFor(item, viewer.id)) return false;
  if (policy === "independent_principal") {
    const member = members?.[viewer.id];
    return Boolean(member && member.active !== false && (member.permissions ?? []).includes("verify"));
  }
  return true;
}

// Whether the board offers the send-back control on a delivered claim
// (H1 / #3888). The update route authorizes the delivered ->
// in_progress transition for the owner, a claim manager, or the
// reviewer who recorded changes_requested; the board shows the control
// to the owner outright, and to a manager or reviewer when a CURRENT
// changes_requested review stands on the claim (basisCurrent, the same
// currency test approvals use). The route re-checks on POST.
export function canSendBackClaim(item, viewer, members) {
  if (!item || item.state !== "delivered" || !viewer?.id) return false;
  if (item.owner === viewer.id) return true;
  const member = members?.[viewer.id];
  if (!member || member.active === false) return false;
  const standing = (item.reviews ?? []).filter(entry => entry?.verdict === "changes_requested" && basisCurrent(entry, item));
  if (!standing.length) return false;
  if (viewer.manage) return true;
  return standing.some(entry => entry.memberId === viewer.id);
}

const sendBackRequestId = (item, memberId) =>
  ["sendback", requestIdPart(item?.id), String(item?.deliveryGeneration ?? 0), requestIdPart(memberId)].join("-");

// The send-back POST body, pure like claimVerifyBody: the transition
// plus its operation identity (#3829's replay binding covers reviewer
// send-backs) and the round basis the board read, so a stale card
// cannot send back a newer round.
export function claimSendBackBody(item, memberId) {
  const basis = typeof item?.claimedAt === "string"
    ? { expectedClaimedAt: item.claimedAt,
      expectedHistoryLength: (Array.isArray(item?.history) ? item.history.length : 0) + (Number(item?.historyOmitted) || 0) }
    : {};
  return { state: "in_progress", requestId: sendBackRequestId(item, memberId), ...basis };
}

// The review POST body (#3889): the reviewer names the basis they
// actually read — the board holds every field of the kernel's
// reviewBasisFor — so an identical re-review after the basis moved is a
// deliberate refresh where the kernel allows one (a sole CI head move),
// instead of a silent no-op the board announces as "Reviewed". A basis
// that no longer matches is refused as a conflict by the kernel.
export function claimReviewBody(item, verdict, summary) {
  return { verdict, summary, expectedBasis: { version: 1, owner: item?.owner ?? null,
    claimedAt: item?.claimedAt ?? null, revision: item?.revision ?? null,
    headSha: item?.ci?.headSha ?? null, deliveryDigest: item?.delivery?.digest ?? null,
    deliveryGeneration: item?.deliveryGeneration ?? 0 } };
}

// #3889 readback: after the board reloads, the submitted review counts
// as recorded only when the reviewer's standing review on the refreshed
// claim carries the submitted verdict + summary AND its basis is still
// current — a stale-basis no-op leaves the old, stale review in place,
// which this refuses to call success.
export function reviewOutcomeConfirmed(item, memberId, verdict, summary) {
  const review = (item?.reviews ?? []).find(entry => entry?.memberId === memberId);
  return Boolean(review && review.verdict === verdict && review.summary === summary && basisCurrent(review, item));
}

// Review controls for a claim card. Every label comes from the strings
// catalog via uiText, and each literal holds only complete HTML tags, so the
// i18n harness sees no new hardcoded copy. The form posts to
// POST /work-claims/:id/review through the board's submit handler.
export function claimReviewForm(item) {
  const id = escapeHtml(item.id);
  return [
    `<form class="board-new" data-claim-review="${id}">`,
    "<span class=\"form-hint\">", uiText("board.review.legend"), "</span>",
    "<label>",
    uiText("board.review.verdict.label"),
    " <select name=\"verdict\" required>",
    "<option value=\"approve\">", uiText("board.review.verdict.approve"), "</option>",
    "<option value=\"changes_requested\">", uiText("board.review.verdict.changes_requested"), "</option>",
    "<option value=\"comment\">", uiText("board.review.verdict.comment"), "</option>",
    "</select>",
    "</label>",
    "<label>",
    uiText("board.review.summary.label"),
    " <input name=\"summary\" required maxlength=\"2000\" autocomplete=\"off\">",
    "</label>",
    "<span class=\"form-hint\">", uiText("board.review.summary.placeholder"), "</span>",
    "<button type=\"submit\" class=\"button secondary\">", uiText("board.review.submit"), "</button>",
    "</form>"
  ].join("");
}

// Operation identity for the board's lifecycle POSTs (#3829): an update
// carrying a requestId records its outcome server-side, and the identical
// retry replays that outcome instead of applying twice. The id is derived
// from the operation itself — claim, delivery round, actor — so a retry of
// the same click re-sends the same id, while a new round or a different
// actor is a new operation with a new id. Sanitized to the route's
// requestId shape.
//
// B4/H2: the round is bound explicitly, not only through
// deliveryGeneration. A release resets the generation to 0, so a
// same-owner re-claim used to derive the IDENTICAL deliver id as round 1
// and the kernel replayed round 1's recorded outcome — the round-2
// delivery was silently swallowed (identical bundle) or refused as a
// conflict (changed bundle). The id now carries a fingerprint of the
// round basis (claimedAt + lifetime history length, the same basis the
// release/reassign posts bind), which every new round changes. The
// kernel also clears recorded outcomes when a round ends, so the two
// fixes are independent locks on the same door.
// Two independent 32-bit string hashes combined into 16 hex chars: not a
// security digest, just a stable fingerprint a browser can compute
// synchronously for id derivation.
const fingerprint = value => {
  const text = String(value ?? "");
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) ^ code) >>> 0;
  }
  return [h1.toString(16).padStart(8, "0"), h2.toString(16).padStart(8, "0")].join("");
};
// Parts were truncated to 40 chars, so two ids sharing a 40-char prefix
// collided into one operation. A long part now keeps a readable prefix
// plus a fingerprint of the FULL value, so distinct values stay distinct.
const requestIdPart = value => {
  const clean = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "-");
  return clean.length <= 40 ? clean : [clean.slice(0, 23), fingerprint(clean)].join("-");
};
const historyLengthOf = item => (Array.isArray(item?.history) ? item.history.length : 0) + (Number(item?.historyOmitted) || 0);
const roundPart = item => fingerprint([item?.claimedAt ?? "", historyLengthOf(item)].join("|"));
export function verifyRequestId(item, memberId) {
  return ["verify", requestIdPart(item?.id), String(item?.deliveryGeneration ?? 0), roundPart(item), requestIdPart(memberId)].join("-");
}
const deliverRequestId = (item, memberId) =>
  ["deliver", requestIdPart(item?.id), String(item?.deliveryGeneration ?? 0), roundPart(item), requestIdPart(memberId)].join("-");

// The round basis a first Verify/Deliver submission is fenced by (H3):
// the kernel's existing preconditions, computed exactly as the board's
// release/reassign posts compute them, so a stale form held across a
// release + re-claim is refused as a conflict instead of replaying into
// the new round. Only a claimed round carries a basis worth posting.
const roundBasis = item => typeof item?.claimedAt === "string"
  ? { expectedClaimedAt: item.claimedAt, expectedHistoryLength: historyLengthOf(item) }
  : {};

// The reviewer's verify as a pure body, so the requestId wiring is
// unit-testable at this boundary (the newItemCreateBody precedent). Before
// this the board posted { state: "done" } alone: no operation identity, so
// a lost response could only be retried as a brand-new update against a
// claim that was already done.
export function claimVerifyBody(item, memberId) {
  return { state: "done", requestId: verifyRequestId(item, memberId), ...roundBasis(item) };
}

const DELIVERY_CHECK_RESULTS = ["pass", "fail", "error", "skipped"];
const CHECK_RESULT_KEYS = { pass: "board.deliver.result.pass", fail: "board.deliver.result.fail",
  error: "board.deliver.result.error", skipped: "board.deliver.result.skipped" };
const CRITERION_STATUS_KEYS = { met: "board.deliver.criterion.met", not_met: "board.deliver.criterion.not_met",
  na: "board.deliver.criterion.na" };

// Delivery controls for a claim card (#3547): under a reviewed policy the
// finish must carry the delivery bundle — { artifact, checks, criteria },
// the kernel's own shape — or the kernel refuses it delivery_incomplete.
// The form composes exactly that bundle from the holder's input, prefilled
// with what the claim already carries: the linked PR as the artifact
// reference, and the stored bundle itself on a re-delivery, so reusing a
// valid bundle is one submit. Labels come from the strings catalog, like
// claimReviewForm; criterion texts are claim data, escaped as values.
export function claimDeliverForm(item) {
  const id = escapeHtml(item.id);
  const pulls = Array.isArray(item.pullRequests) && item.pullRequests.length ? item.pullRequests
    : (item.pullRequest?.url ? [item.pullRequest] : []);
  const artifact = item.delivery?.artifact ?? null;
  const kind = artifact?.kind ?? (pulls.length ? "pull_request" : "");
  const ref = artifact?.ref ?? pulls[0]?.url ?? "";
  const sha = artifact?.sha256 ?? "";
  const checks = Array.isArray(item.delivery?.checks) && item.delivery.checks.length ? item.delivery.checks : [null];
  // Composed like claimReviewForm — array pieces and complete-tag literals
  // with at most one interpolation each — so the i18n harness sees no
  // sentence building. Repeated rows share one field name; the body
  // builder reads them back in order with getAll.
  const option = (value, selected, label) => ["<option value=\"", value, "\"",
    selected ? " selected" : "", ">", label, "</option>"].join("");
  const parts = [
    `<form class="board-new" data-claim-deliver="${id}">`,
    "<span class=\"form-hint\">", uiText("board.deliver.legend"), "</span>",
    "<label>", uiText("board.deliver.artifact.kind"),
    ` <input name="artifactKind" required maxlength="64" autocomplete="off" value="${escapeHtml(kind)}">`, "</label>",
    "<label>", uiText("board.deliver.artifact.ref"),
    ` <input name="artifactRef" required maxlength="512" autocomplete="off" value="${escapeHtml(ref)}">`, "</label>",
    "<label>", uiText("board.deliver.artifact.sha256"),
    ` <input name="artifactSha256" required maxlength="71" autocomplete="off" value="${escapeHtml(sha)}">`, "</label>",
  ];
  checks.forEach(entry => {
    parts.push("<label>", uiText("board.deliver.check.name"),
      ` <input name="checkName" required maxlength="200" autocomplete="off" value="${escapeHtml(entry?.name ?? "")}">`, "</label>",
      "<label>", uiText("board.deliver.check.result"), " <select name=\"checkResult\">",
      ...DELIVERY_CHECK_RESULTS.map(result => option(result, entry?.result === result, uiText(CHECK_RESULT_KEYS[result]))),
      "</select>", "</label>");
  });
  const criteria = Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : [];
  if (criteria.length) {
    const mappedStatus = new Map((Array.isArray(item.delivery?.criteria) ? item.delivery.criteria : [])
      .map(entry => [entry?.criterion, entry?.status]));
    parts.push("<span class=\"form-hint\">", uiText("board.deliver.criteria.legend"), "</span>");
    criteria.forEach(criterion => {
      const selected = mappedStatus.get(criterion) ?? "met";
      parts.push("<label>", escapeHtml(criterion), " <select name=\"criterion\">",
        ...Object.keys(CRITERION_STATUS_KEYS).map(status => option(status, selected === status, uiText(CRITERION_STATUS_KEYS[status]))),
        "</select>", "</label>");
    });
  }
  parts.push("<button type=\"submit\" class=\"button primary\">", uiText("board.action.deliver"), "</button>", "</form>");
  return parts.join("");
}

// The deliver POST body, composed from the form's fields — pure, so the
// bundle wiring is unit-testable at this boundary. It mirrors the kernel's
// shape bounds (deliveryOf / requireBundleComplete in work-claims.mjs) and
// returns null when the fields cannot form a bundle the kernel accepts,
// so the board refuses locally with the reason instead of posting a
// refusal. Policy refusals the kernel owns (a failing check, say) still
// surface from the server, which names them.
export function claimDeliverBody(item, data, memberId) {
  const field = name => String(data?.get(name) ?? "").trim();
  const kind = field("artifactKind"), ref = field("artifactRef");
  const sha256 = field("artifactSha256").replace(/^sha256:/, "");
  if (!kind || kind.length > 64 || !ref || ref.length > 512 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const all = name => (typeof data?.getAll === "function" ? data.getAll(name) : [])
    .map(value => String(value ?? "").trim());
  const checkNames = all("checkName"), checkResults = all("checkResult");
  const checks = [];
  for (let index = 0; index < checkNames.length; index++) {
    const name = checkNames[index], result = checkResults[index] ?? "";
    if (!name || name.length > 200 || !DELIVERY_CHECK_RESULTS.includes(result)) return null;
    checks.push({ name, result });
  }
  if (!checks.length) return null;
  const statuses = all("criterion");
  const criteria = [];
  const wanted = Array.isArray(item?.acceptanceCriteria) ? item.acceptanceCriteria : [];
  for (let index = 0; index < wanted.length; index++) {
    const status = statuses[index] ?? "";
    if (!Object.hasOwn(CRITERION_STATUS_KEYS, status)) return null;
    criteria.push({ criterion: wanted[index], status });
  }
  return { state: "delivered",
    delivery: { artifact: { kind, ref, sha256 }, checks, criteria },
    requestId: deliverRequestId(item, memberId), ...roundBasis(item) };
}

// H4 readback for the Deliver submit: the refreshed claim confirms the
// delivery only when it is actually delivered, by this member, carrying
// the submitted bundle. The kernel's delivery digest is a pure function
// of exactly { artifact, checks, criteria } (deliveryDigest in
// work-claims.mjs), so field equality with the submitted bundle is
// equality with the submitted bundle's digest — a claim delivered with
// any other bundle does not confirm this submit.
export function deliverOutcomeConfirmed(item, body, memberId) {
  if (!item || item.state !== "delivered" || !item.delivery || !body?.delivery) return false;
  if (item.delivery.deliveredBy !== memberId) return false;
  const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return same(item.delivery.artifact, body.delivery.artifact)
    && same(item.delivery.checks, body.delivery.checks)
    && same(item.delivery.criteria, body.delivery.criteria);
}

// One anchor literal for both record targets, so the board's link shape
// (and its i18n-harness footprint) stays exactly the one the legacy link
// already had; claim links differ only by the prebuilt marker attribute.
function recordAnchor(id, key, label, claimAttr) {
  return `<a href="#pr-record/work/${encodeURIComponent(id)}" data-open-work="${escapeHtml(id)}"${claimAttr} data-focus-key="${escapeHtml(key)}">${escapeHtml(label)}</a>`;
}

function workLink(item, workItems, key, label, { claimRecord = false } = {}) {
  const linked = typeof item?.workItemId === "string" && Object.hasOwn(workItems ?? {}, item.workItemId) && workItems[item.workItemId]?.id === item.workItemId;
  if (linked) return recordAnchor(item.workItemId, key, label, "");
  // #3795: a board-native claim has no legacy work item behind it (the
  // post-migration norm), so it opens its OWN record — the card's record
  // disclosure — through the same #pr-record/work route and data-open-work
  // dispatch conversation records use. data-open-claim marks the target as
  // a claim so the app routes it to the board instead of the workItems
  // timeline. Callers pass claimRecord only when the claim's card is on
  // the board (a title always is; a reference only when its target is
  // placed) — a claim the board does not show keeps the plain-text label
  // instead of a link whose reveal would honestly fail.
  if (claimRecord && item && typeof item.id === "string" && typeof item.state === "string") {
    return recordAnchor(item.id, key, label, ` data-open-claim="${escapeHtml(item.id)}"`);
  }
  return escapeHtml(label);
}

function claimReference(id, byId, workItems, key, now) {
  const target = byId.get(id);
  const label = target?.title ? `${target.title} (#${id})` : `#${id}`;
  return workLink(target, workItems, key, label, { claimRecord: Boolean(target && columnOf(target, byId, now)) });
}

function canLinkPullRequest(item, viewer, now) {
  return viewer.write && viewer.id === item.owner && !item.supersededBy
    && ["claimed", "in_progress", "blocked"].includes(item.state)
    && (!item.leaseExpiresAt || Date.parse(item.leaseExpiresAt) > now);
}

function reviewLabel(review, item) {
  if (review.verdict !== "approve") return String(review.verdict ?? "").replaceAll("_", " ");
  const attested = (item.attestations ?? []).some(entry => entry.memberId === review.memberId && entry.at === review.at);
  return basisCurrent(review, item) && attested ? "approve" : "previous approval · does not qualify for current work";
}

// The claim's record (#3795): the fields the card summary leaves out —
// acceptance criteria, evidence, the frozen delivery bundle, the
// verification fact and the history the board read carries — rendered as a
// disclosure on the card itself, from the same claim object the list
// already returned. One record model: this is a view of the claim, not a
// second projection. History arrives newest-first and truncated by the
// list read; the omitted count is disclosed rather than silently dropped.
// Composed like claimReviewForm — array pieces, each literal a complete tag
// or a lone catalog string — so the i18n harness sees no new hardcoded copy.
function claimRecordHtml(item, members) {
  const parts = [];
  const section = (labelKey, body) => ["<p class=\"claim-record-label\">", uiText(labelKey), "</p>", body].join("");
  const listOf = values => ["<ul>", values.map(value => ["<li>", escapeHtml(value), "</li>"].join("")).join(""), "</ul>"].join("");
  const criteria = Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : [];
  if (criteria.length) parts.push(section("board.record.criteria", listOf(criteria)));
  const evidence = Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [];
  if (evidence.length) parts.push(section("board.record.evidence", listOf(evidence)));
  if (item.delivery) {
    // The kernel's frozen bundle (#3547): { artifact, checks, criteria }
    // plus digest / deliveredBy / deliveredAt (deliveryOf in
    // work-claims.mjs). Render exactly those fields — an earlier version
    // read result / merged / production, which no delivery carries, so
    // the real evidence never reached the record.
    const delivery = item.delivery;
    const rows = [];
    if (delivery.artifact) {
      const artifact = delivery.artifact;
      const line = [artifact.kind, artifact.ref, artifact.sha256 ? `sha256:${artifact.sha256}` : ""]
        .filter(value => typeof value === "string" && value).join(" · ");
      if (line) rows.push(["<p>", escapeHtml(line), "</p>"].join(""));
    }
    const checks = Array.isArray(delivery.checks) ? delivery.checks : [];
    if (checks.length) rows.push(listOf(checks.map(entry => [entry?.name, entry?.result, entry?.command]
      .filter(value => typeof value === "string" && value).join(" — "))));
    const mapped = Array.isArray(delivery.criteria) ? delivery.criteria : [];
    if (mapped.length) rows.push(listOf(mapped.map(entry => [entry?.criterion, entry?.status]
      .filter(value => typeof value === "string" && value).join(" — ")
      + (typeof entry?.evidenceRef === "string" && entry.evidenceRef ? ` · ${entry.evidenceRef}` : ""))));
    const by = delivery.deliveredBy ? memberName(members, delivery.deliveredBy) || delivery.deliveredBy : "";
    const line = [by, delivery.deliveredAt ?? ""].filter(Boolean).join(" · ");
    if (line) rows.push(["<p>", escapeHtml(line), "</p>"].join(""));
    if (rows.length) parts.push(section("board.record.delivery", rows.join("")));
  }
  if (item.verification) {
    const by = item.verification.by ? memberName(members, item.verification.by) || item.verification.by : "";
    const line = [item.verification.state ?? "", by, item.verification.at ?? ""].filter(Boolean).join(" · ");
    parts.push(section("board.record.verification", ["<p>", escapeHtml(line), "</p>"].join("")));
  }
  const history = Array.isArray(item.history) ? item.history : [];
  const omitted = Number(item.historyOmitted) || 0;
  if (history.length || omitted > 0) {
    const rows = history.map(entry => ["<li>", escapeHtml(entry?.action ?? ""),
      entry?.agentId ? [" · ", escapeHtml(memberName(members, entry.agentId) || entry.agentId)].join("") : "",
      entry?.note ? [" — ", escapeHtml(entry.note)].join("") : "", "</li>"].join("")).join("");
    const note = omitted > 0
      ? ["<p class=\"form-hint\">", escapeHtml(uiText("board.record.history.omitted", { count: omitted })), "</p>"].join("")
      : "";
    parts.push(section("board.record.history", [rows ? ["<ul>", rows, "</ul>"].join("") : "", note].join("")));
  }
  if (!parts.length) return "";
  return [`<details class="claim-record" data-claim-record="${escapeHtml(item.id)}"><summary>`, uiText("board.record.summary"), "</summary>", parts.join(""), "</details>"].join("");
}

function cardHtml(item, viewer, members, now, workItems, byId, roomPolicy = null) {
  const ownerId = item.owner;
  const owner = ownerId ? memberName(members, ownerId) : "Unclaimed";
  const mine = Boolean(viewer.id && ownerId === viewer.id);
  const files = Array.isArray(item.files) ? item.files : [];
  const blocks = item.fileBlocks && typeof item.fileBlocks === "object" ? item.fileBlocks : {};
  const fileLabel = file => blocks[file] ? `${file} (${blocks[file]})` : file;
  const fileBlock = files.length
    ? `<details class="claim-files"><summary>${files.length} file${files.length === 1 ? "" : "s"}</summary><ul>${files.map(file => `<li>${escapeHtml(fileLabel(file))}</li>`).join("")}</ul></details>`
    : "";
  const lease = item.state === "done" ? "" : countdown(item.leaseExpiresAt, now);
  const pulls = Array.isArray(item.pullRequests) && item.pullRequests.length ? item.pullRequests : (item.pullRequest?.url ? [item.pullRequest] : []);
  const pr = pulls.map((pull, index) => {
    const number = pullNumber(pull.url);
    const outcome = pull.outcome ? ` · ${pull.outcome}` : "";
    const ci = index === 0 && item.ci?.state ? ` <span class="ci-badge ci-${escapeHtml(item.ci.state)}">${escapeHtml(item.ci.state)}</span>` : "";
    const link = safePrUrl(pull.url)
      ? `<a href="${escapeHtml(pull.url)}">PR ${number ? `#${escapeHtml(number)}` : "link"}</a>`
      : `<span>PR ${number ? `#${escapeHtml(number)}` : escapeHtml(String(pull.url ?? "link"))}</span>`;
    return `<p class="claim-pr">${link}${escapeHtml(outcome)}${ci}</p>`;
  }).join("");  const place = item.repo || item.branch
    ? `<p class="claim-repo">${escapeHtml([item.repo, item.branch].filter(Boolean).join("@"))}</p>`
    : "";
  const chain = Array.isArray(item.chain) ? item.chain : [];
  const links = chain.map((link, index) => `<li>${escapeHtml(link.kind)} → ${claimReference(link.targetId, byId, workItems, `claim-chain:${item.id}:${index}`, now)}${link.note ? ` · ${escapeHtml(link.note)}` : ""}</li>`).join("");
  const reviews = Array.isArray(item.reviews) && item.reviews.length
    ? `<ul class="claim-reviews">${item.reviews.map(review => `<li>${escapeHtml(memberName(members, review.memberId) || review.memberId)} ${escapeHtml(reviewLabel(review, item))}</li>`).join("")}</ul>`
    : "";
  const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn : [];
  const remaining = dependencies.filter(id => byId.get(id)?.state !== "done");
  const waiting = item.state === "unclaimed" && !item.owner && remaining.length > 0;
  const reason = waiting ? `<p class="form-hint claim-waiting">Waiting for ${remaining.length} prerequisite${remaining.length === 1 ? "" : "s"} before claiming.</p>` : "";
  const deps = dependencies.map((id, index) => {
    const target = byId.get(id);
    const status = !target ? "Not loaded or unavailable; status unknown"
      : target.state === "done" ? "Completed"
      : target.state === "unclaimed" && !target.owner ? "Unclaimed; needs an owner"
      : ({ claimed: "Claimed", in_progress: "In progress", blocked: "Blocked" }[target.state] ?? "Status unknown");
    const reference = claimReference(id, byId, workItems, `claim-dependency:${item.id}:${index}`, now);
    return `<li>${target?.state === "done" ? "Prerequisite" : "Waiting for"} ${reference} · ${escapeHtml(status)}</li>`;
  }).join("");
  const button = (action, label, tone) => `<button type="button" class="button ${tone}" data-claim-action="${action}" data-claim-id="${escapeHtml(item.id)}" data-focus-key="${action}:${escapeHtml(item.id)}">${label}</button>`;
  const actions = [];
  if (canLinkPullRequest(item, viewer, now)) {
    actions.push(`<form class="board-new" data-claim-link-pr="${escapeHtml(item.id)}"><label>Pull request URL <input name="pullRequest" type="url" size="1" maxlength="300" required autocomplete="off" placeholder="https://github.com/…/pull/…" aria-label="Pull request URL for ${escapeHtml(item.title || item.id)}" data-focus-key="link-pr:${escapeHtml(item.id)}"></label><button type="submit" class="button secondary">Link PR</button></form>`);
  }
  // VERIFY step: the board used to render no review control at all — "What
  // needs me › Review" only scrolled to the card (dead end). Eligible
  // reviewers now get the verdict form right on the card.
  if (canReviewClaim(item, viewer, members)) actions.push(claimReviewForm(item));
  // The delivered end of the lifecycle (#3795/#3754): a reviewer whose
  // approval is still current against the delivered bundle verifies it to
  // done from the same card. The update route re-runs canCloseWork on POST;
  // this only renders the control when the claim could actually close for
  // this viewer — policy-aware since B4 (#3885/#3887, canVerifyFromBoard).
  if (canVerifyFromBoard(item, viewer, members, roomPolicy)) {
    actions.push(button("verify", uiText("board.action.verify"), "primary"));
  }
  // H1 (#3888): the send-back control. After a changes_requested review
  // the delivered claim used to sit with Close as the holder's only
  // offered exit; the route-authorized actors (owner, claim manager,
  // that reviewer) now get the delivered -> in_progress transition.
  if (canSendBackClaim(item, viewer, members)) {
    actions.push(button("sendback", uiText("board.action.sendback"), "secondary"));
  }
  if (item.state === "unclaimed" && !item.owner && !waiting) actions.push(button("claim", "Claim", "primary"));
  if (mine && ["claimed", "in_progress", "blocked"].includes(item.state)) actions.push(button("renew", "Renew", "secondary"));
  if (mine && (item.state === "claimed" || item.state === "blocked")) actions.push(button("progress", "Mark in progress", "secondary"));
  if (mine && item.state === "in_progress") {
    // Under a reviewed policy the single-step finish is refused
    // (work_not_delivered): the holder finishes to delivered with the
    // delivery bundle, and the reviewer verifies from there — so the card
    // offers the step the policy actually accepts. The step is the deliver
    // form, not a bare button: a first finish without the bundle is
    // refused delivery_incomplete, so the form composes it.
    const policy = item.reviewPolicy ?? roomPolicy ?? "self_attested";
    // H5 (#3886): under self_attested a criteria-bearing claim's bare
    // Done is a guaranteed refusal — the kernel's finish requires a
    // first delivery bundle whenever criteria exist — so the card
    // offers the bundle-carrying deliver form for exactly that class;
    // the claim then completes from delivered via the owner-verify
    // control (#3887). Criteria-free self-attested claims keep Done.
    if (policy === "self_attested" && !(Array.isArray(item.acceptanceCriteria) && item.acceptanceCriteria.length)) {
      actions.push(button("done", "Done", "primary"));
    } else actions.push(claimDeliverForm(item));
  }
  if (viewer.manage && ownerId && item.state !== "done" && item.state !== "unclaimed") {
    actions.push(button("release", "Release", "secondary"));
    const options = Object.values(members ?? {}).filter(member => member && member.active !== false && member.id !== ownerId)
      .map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(memberName(members, member.id))}</option>`).join("");
    if (options) actions.push(`<form data-claim-reassign="${escapeHtml(item.id)}"><label>Reassign <select name="newOwner" aria-label="Reassign ${escapeHtml(item.title)}">${options}</select></label><button type="submit" class="button secondary">Move</button></form>`);
  }
  // Claim lifecycle: close (holder or claim manager) and cancel (creator of
  // an unclaimed item, or its holder) retire open work without delivery.
  if (viewer.write && item.state !== "done" && item.state !== "closed") {
    const opener = item.state === "unclaimed" && !item.owner && !item.historyOmitted
      && item.history?.[0]?.action === "created" && item.history[0].agentId === viewer.id;
    if (viewer.manage || mine) actions.push(button("close", "Close", "secondary"));
    else if (opener) actions.push(button("cancel", "Cancel", "secondary"));
  }
  const title = workLink(item, workItems, `claim-work:${item.id}`, item.title || item.id, { claimRecord: true });
  const record = claimRecordHtml(item, members);
  return `<article class="claim-card" data-claim-id="${escapeHtml(item.id)}"><h4 tabindex="-1">${title}</h4><p class="claim-owner">${ownerId ? `<span class="member-avatar" aria-hidden="true">${escapeHtml(initials(owner))}</span> ` : ""}<span>${escapeHtml(owner)}</span></p>${place}${fileBlock}${lease ? `<p class="claim-lease">${escapeHtml(lease)}</p>` : ""}${pr}${reviews}${reason}${deps ? `<ul class="claim-deps">${deps}</ul>` : ""}${links ? `<ul class="claim-chain">${links}</ul>` : ""}${record}<div class="claim-actions">${actions.join("")}</div></article>`;
}

function newItemForm() {
  return `<form id="board-new-item" class="board-new"><h3>New item</h3><label>Title <input name="title" data-focus-key="board-new-title" maxlength="200" required autocomplete="off"></label><label>Note <input name="note" data-focus-key="board-new-note" maxlength="4000" autocomplete="off" placeholder="Optional, context for whoever picks this up"></label><label>Files <input name="files" data-focus-key="board-new-files" maxlength="4000" autocomplete="off" placeholder="Optional, comma-separated"></label><button type="submit" class="button primary" data-focus-key="board-new-submit">Add item</button></form>`;
}

// S3: the create API accepts a note, but the form never sent one (F-parity-1).
// Pure body builder so the note wiring is unit-testable at this boundary.
export function newItemCreateBody(data) {
  const title = String(data?.get("title") ?? "").trim();
  if (!title) return null;
  const body = { id: claimIdFromTitle(title), title };
  const note = String(data?.get("note") ?? "").trim();
  if (note) body.note = note;
  const files = filesFromField(data?.get("files"));
  if (files.length) body.files = files;
  return body;
}

// Loading states (BU-02): the board never shows the empty-board copy while a
// read is in flight. With no items yet it renders skeleton columns; with
// items it keeps the stale board and says it is refreshing; a failed load
// gets an honest error with a retry button instead of a silent empty board.
export function boardSkeletonHtml() {
  const card = `<div class="sk-card"><span class="sk-line"></span><span class="sk-line short"></span><span class="sk-line shorter"></span></div>`;
  return `<div class="board-skeleton" aria-hidden="true">${COLUMNS.map(([, label]) => `<section><h3>${escapeHtml(label)}</h3>${card}${card}</section>`).join("")}</div>`;
};

const PENDING_OUTCOME_KEYS = {
  claim: "board.action.pending.claim",
  renew: "board.action.pending.renew",
  progress: "board.action.pending.progress",
  done: "board.action.pending.done",
  deliver: "board.action.pending.deliver",
  verify: "board.action.pending.verify",
  sendback: "board.action.pending.sendback",
  release: "board.action.pending.release",
  close: "board.action.pending.close",
  cancel: "board.action.pending.cancel",
  reassign: "board.action.pending.reassign",
  create: "board.action.pending.create",
};

// In-flight narration for every board action, so the board never looks frozen
// mid-request. Pure: the installWorkBoard handlers pass titleOf(id).
export function pendingOutcome(action, title) {
  if (action === "sweep") return uiText("board.action.pending.sweep");
  const key = PENDING_OUTCOME_KEYS[action];
  return key ? uiText(key, { title }) : "";
}

function filterBarHtml(filter = {}) {
  return uiText("board.filter.bar", {
    region: escapeHtml(uiText("board.filter.region")),
    placeholder: escapeHtml(uiText("board.filter.search.placeholder")),
    searchAria: escapeHtml(uiText("board.filter.search.aria")),
    value: escapeHtml(String(filter?.q ?? "")),
    checked: filter?.mine ? " checked" : "",
    clear: filterActive(filter) ? `<button type="button" class="button ghost" data-board-filter-clear>Clear</button>` : "",
  });
}

export function boardHtml(items, status, viewer, members, now, { older = false, canWrite = false, capabilities = [], cap = 20, workItems = {}, loading = false, loadError = false, filter = {}, reviewPolicy = null } = {}) {
  const all = Array.isArray(items) ? items : [];
  const visible = filterClaims(all, filter, viewer?.id, members);
  // The filter narrows display only: placement and dependency status are
  // facts about the full loaded board. Place every claim against the full
  // list (so a filtered-out prerequisite still counts as met or unmet
  // exactly as it is), then keep only the visible cards in each column.
  // Card lookups likewise resolve against the full list, so a dependency
  // the filter hid reports its real status instead of "unknown".
  const visibleIds = new Set(visible.map(item => item.id));
  const placed = placeClaims(all, now);
  const columns = Object.fromEntries(Object.entries(placed).map(([id, rows]) => [id, rows.filter(item => visibleIds.has(item.id))]));
  const byId = new Map(all.map(item => [item.id, item]));
  const waitingCount = columns.blocked.filter(item => item.state === "unclaimed" && !item.owner).length;
  const sweep = viewer.manage ? `<button type="button" class="button secondary" id="board-close-stale" data-claim-action="sweep" data-focus-key="board-close-stale">Close stale</button>` : "";
  const capForm = viewer.owner ? `<form data-claim-cap><label>Claims per member <input name="maxMemberOpenClaims" data-focus-key="board-cap-value" type="number" min="1" max="10000" value="${escapeHtml(String(cap ?? 20))}" aria-label="Open claims per member"></label><button type="submit" data-focus-key="board-cap-save">Save cap</button></form>` : "";
  const form = canWrite ? newItemForm() : "";
  const hint = older ? `<p class="form-hint board-older">Older landed work is in the API</p>` : "";
  const bar = filterBarHtml(filter);
  const colEmpty = filterActive(filter) ? uiText("board.filter.column.empty") : "Nothing here.";
  // The section literal below is verbatim the board's original column markup:
  // it stays one grandfathered i18n literal instead of growing the ratchet.
  const columnSections = COLUMNS.map(([id, label]) => `<section aria-labelledby="board-col-${id}"><h3 id="board-col-${id}">${label}${id === "blocked" && waitingCount ? ` · ${waitingCount} waiting` : ""}</h3>${columns[id].map(item => cardHtml(item, viewer, members, now, workItems, byId, reviewPolicy)).join("") || `<p class="form-hint">${colEmpty}</p>`}</section>`).join("");
  const columnsHtml = `<div class="board-columns">${columnSections}</div>`;
  // The filter bar rides above the board content; BU-02's loading states keep
  // precedence — skeleton while the first read is in flight, the error (not
  // the empty copy) on a failed load with nothing to show.
  const emptyCopy = `<p class="board-empty">${escapeHtml(emptyBoardCopy(capabilities, { canWrite, signedIn: Boolean(viewer?.id) }))}</p>${hint}`;
  const board = all.length
    ? [bar, hint, filterEmptyCopy(filter, visible.length) || columnsHtml].join("")
    : loading ? boardSkeletonHtml()
    : loadError ? ""
    : [bar, hint, emptyCopy].join("");
  const needsMe = all.length ? needsMeHtml(all, viewer, members, now) : "";
  // A failed refresh keeps the stale board but must still say so, with retry.
  const loadFailure = loadError && !loading ? uiText("board.loading.error") : "";
  const loadingNote = loading ? uiText(all.length ? "board.loading.002" : "board.loading.001") : "";
  return `${needsMe}${form}<div class="board-head"><p class="live-chip">${escapeHtml(liveLabel(status))}</p>${sweep}${capForm}</div><p id="board-status" class="form-hint" role="status">${escapeHtml(loadingNote)}</p>${loadFailure}${board}`;
}

function staleDonePage(claims, now) {
  return claims.length > 0 && claims.every(item => {
    if (item?.state !== "done") return false;
    const at = Date.parse(updatedAt(item));
    return Number.isFinite(at) && now - at > WEEK;
  });
}

async function readClaims(client, current, now = Date.now()) {
  const claims = [];
  let cursor = null;
  let older = false;
  for (let page = 0; page < 20; page += 1) {
    if (!current()) break;
    const query = new URLSearchParams({ limit: "200" });
    // The list route leaves out landed work older than a week and counts it
    // in olderDone. A page of only old done items still ends the walk, for a
    // server that predates that window.
    if (cursor) query.set("cursor", cursor);
    const body = await client.request(client.path(`/work-claims?${query}`));
    if (!current()) break;
    const pageClaims = body.claims ?? [];
    claims.push(...pageClaims);
    if (Number(body.olderDone) > 0) older = true;
    if (staleDonePage(pageClaims, now)) { older = true; break; }
    if (!body.nextCursor) return { claims, older };
    cursor = body.nextCursor;
  }
  return { claims, older };
}

function claimIdFromTitle(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${slug || "item"}-${suffix}`.slice(0, 128);
}

function filesFromField(value) {
  return String(value ?? "").split(/[\n,]/).map(part => part.trim()).filter(Boolean).slice(0, 64);
}

export function installWorkBoard({ client, getState, getSession }) {
  const root = document.querySelector("#work-board");
  if (!root) return { sync() {}, reset() {}, async whenReady() { return false; }, async revealClaim() { return false; } };
  let items = [];
  let status = null;
  let cap = 20;
  let reviewPolicy = null;
  let older = false;
  let seen = null;
  let loadedRoom = null;
  let loadedContext = null, operation = 0, readFlight = null, actionFlight = null;
  let boardLoading = false, boardLoadError = false;
  const context = () => {
    const current = getSession(), member = current?.member?.id;
    return current?.roomId && member && getState()?.members?.[member]?.id === member && getState().members[member].active !== false
      ? `${client.generation}|${current.roomId}|${member}` : null;
  };
  let mutating = false;
  let pendingFocus = null;
  let pendingStatus = "";
  let stick = null;
  // Board search and "mine only" filter. Client-side narrowing of the loaded
  // claims; cleared on room/member context change.
  let filter = { q: "", mine: false };
  let pendingCaret = null;

  function paint() {
    const state = getState();
    const session = getSession();
    const active = document.activeElement;
    const restoreFocus = !active || active === document.body || root.contains(active);
    if (pendingFocus) stick = { key: pendingFocus.key ?? null, id: pendingFocus.id ?? null, status: pendingStatus };
    else if (restoreFocus) {
      const key = active?.closest?.("[data-focus-key]")?.dataset.focusKey ?? null;
      if (key) stick = { key, id: active.closest("article")?.dataset.claimId ?? null, status: stick?.status ?? "" };
    }
    pendingFocus = null;
    pendingStatus = "";
    root.innerHTML = boardHtml(items, status, viewerOf(state, session), state?.members ?? {}, Date.now(), {
      older, canWrite: canWriteClaims(state, session), capabilities: advertisedCapabilities(state), cap, workItems: state?.workItems ?? {},
      loading: boardLoading, loadError: boardLoadError, filter, reviewPolicy
    });
    // This control's markup comes from the shared strings catalog.
    root.querySelector('[data-board-filter] [name="mine"]')?.setAttribute("data-focus-key", "board-filter-mine");
    if (stick?.status) {
      const line = root.querySelector("#board-status");
      if (line) line.textContent = stick.status;
    }
    if (!restoreFocus || !stick) {
      if (pendingCaret) restoreFilterCaret();
      return;
    }
    const same = stick.key ? root.querySelector(`[data-focus-key="${CSS.escape(stick.key)}"]`) : null;
    const heading = !same && stick.id ? root.querySelector(`article[data-claim-id="${CSS.escape(stick.id)}"] h4`) : null;
    (same || heading)?.focus();
    if (pendingCaret) restoreFilterCaret();
  }

  // Typing in the filter repaints the whole board, which replaces the input
  // node; restore the caret where the typist left it instead of jumping.
  function restoreFilterCaret() {
    const caret = pendingCaret;
    pendingCaret = null;
    if (!caret) return;
    const field = root.querySelector('[data-focus-key="board-filter-q"]');
    if (!field) return;
    field.focus({ preventScroll: true });
    try { field.setSelectionRange(caret.start, caret.end); } catch { /* non-text input */ }
  }

  function note(text) {
    stick = { ...(stick ?? {}), status: text };
    const line = root.querySelector("#board-status");
    if (line) line.textContent = text;
  }

  function titleOf(id) {
    return items.find(item => item.id === id)?.title || id;
  }

  function outcome(action, id) {
    const title = titleOf(id);
    if (action === "claim") return `Claimed '${title}'`;
    if (action === "renew") return `Renewed '${title}'`;
    if (action === "progress") return `Marked '${title}' in progress`;
    if (action === "done") return `Done '${title}'`;
    if (action === "deliver") return uiText("board.action.outcome.deliver", { title });
    if (action === "verify") return uiText("board.action.outcome.verify", { title });
    if (action === "sendback") return uiText("board.action.outcome.sendback", { title });
    if (action === "release") return `Released '${title}'`;
    if (action === "close" || action === "cancel") return uiText(action === "close" ? "board.claim.closed" : "board.claim.cancelled", { title });
    if (action === "reassign") return `Reassigned '${title}'`;
    if (action === "create") return `Opened '${title}'`;
    return "Closed stale claims";
  }

  async function load({ force = false, focus = null } = {}) {
    const session = getSession(), owned = context();
    if (!owned) return;
    if (loadedContext !== owned) {
      operation++; mutating = false; readFlight = null; actionFlight = null; loadedRoom = null; seen = null; items = []; status = null;
      loadedContext = owned; pendingFocus = null; pendingStatus = ""; stick = null; filter = { q: "", mine: false }; pendingCaret = null; paint();
    }
    if ((mutating && !force) || readFlight) return;
    const events = (getState()?.eventLog ?? []).filter(event => event.type === "work_claim.updated");
    const mark = events.length ? events[events.length - 1].id : "";
    if (!force && loadedRoom === session.roomId && seen === mark) return;
    const mine = ++operation;
    boardLoading = true; boardLoadError = false; paint();
    let pending = null;
    try {
      pending = Promise.all([
        readClaims(client, () => mine === operation && context() === owned),
        client.request(client.path("/work-claims/status")),
        client.request(client.path("/work-claims/config"))
      ]);
      readFlight = pending;
      const [page, live, config] = await pending;
      if (mine !== operation || context() !== owned) return;
      items = page.claims;
      older = page.older;
      status = live;
      cap = config?.maxMemberOpenClaims ?? cap;
      reviewPolicy = config?.reviewPolicy ?? reviewPolicy;
      loadedRoom = session.roomId;
      seen = mark;
      boardLoading = false;
      // Announce completion only with the fresh claim state. Loading and
      // filter paints must not consume an action's success while it is pending.
      if (focus) { pendingFocus = { key: focus.key ?? null, id: focus.id ?? null }; pendingStatus = focus.status ?? ""; }
      paint();
      return true;
    } catch {
      if (mine !== operation || context() !== owned) return false;
      // Honest failure: the error block (with retry) replaces the board
      // instead of a silent empty board plus a status whisper.
      boardLoading = false;
      boardLoadError = true;
      stick = null;
      paint();
      return false;
    } finally {
      if (mine === operation) boardLoading = false;
      if (readFlight === pending) readFlight = null;
    }
  }

  async function act(run, focus, reconcile = null, unconfirmed = "Could not confirm the PR link. Refresh the board before trying again.") {
    const owned = context();
    if (!owned || loadedContext !== owned || mutating) return;
    const mine = ++operation;
    // An explicit action supersedes a background read; its stale response
    // cannot paint or block the fresh list after this mutation.
    readFlight = null;
    mutating = true;
    if (focus?.pending) note(focus.pending);
    let pending = null;
    try {
      pending = run(); actionFlight = pending;
      await pending;
      if (mine !== operation || context() !== owned) return;
      // Keep duplicate mutations excluded until their new state is visible.
      const refreshed = await load({ force: true, focus });
      if (reconcile && actionFlight === pending && context() === owned) {
        note(refreshed ? reconcile(null) : unconfirmed);
      }
    } catch (error) {
      if (mine !== operation || context() !== owned) return;
      if (reconcile) {
        note("Checking the current claim…");
        const refreshed = await load({ force: true, focus });
        if (actionFlight === pending && context() === owned) {
          note(refreshed ? reconcile(error) : unconfirmed);
        }
      } else {
        pendingFocus = null;
        pendingStatus = "";
        note(error?.message || "Could not update the claim.");
      }
    } finally {
      if (actionFlight === pending) { actionFlight = null; mutating = false; }
    }
  }

  // In-flight button feedback (BU-02): the clicked control disables with
  // aria-busy so the board never looks frozen mid-request. paint() removes
  // the node on success; if it survives (failed action, no repaint) it is
  // re-enabled here.
  function flyButton(button, run, focus, reconcile = null, unconfirmed = undefined) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    act(run, focus, reconcile, unconfirmed).finally(() => {
      if (root.contains(button)) { button.disabled = false; button.removeAttribute("aria-busy"); }
    });
  }

  root.addEventListener("input", event => {
    const form = event.target.closest("[data-board-filter]");
    if (!form || !root.contains(form)) return;
    const data = new FormData(form);
    filter = { q: String(data.get("q") ?? ""), mine: form.querySelector('[name="mine"]')?.checked ?? false };
    const field = event.target;
    pendingCaret = field?.name === "q" && typeof field.selectionStart === "number"
      ? { start: field.selectionStart, end: field.selectionEnd } : null;
    paint();
  });
  root.addEventListener("click", event => {
    const retry = event.target.closest("[data-board-retry]");
    if (retry && root.contains(retry)) { retry.disabled = true; void load({ force: true }); return; }
    const clear = event.target.closest("[data-board-filter-clear]");
    if (clear && root.contains(clear)) {
      filter = { q: "", mine: false };
      pendingCaret = null;
      stick = { key: "board-filter-q", id: null, status: "" };
      paint();
      return;
    }
    const jump = event.target.closest("[data-needs-me-open]");
    if (jump && root.contains(jump)) {
      const card = root.querySelector(`article[data-claim-id="${CSS.escape(jump.dataset.needsMeOpen)}"]`);
      card?.scrollIntoView({ block: "center", behavior: "smooth" });
      card?.querySelector("h4")?.focus({ preventScroll: true });
      return;
    }
    const button = event.target.closest("[data-claim-action]");
    if (!button || !root.contains(button)) return;
    const id = button.dataset.claimId;
    const action = button.dataset.claimAction;
    const focus = { key: button.dataset.focusKey ?? null, id: id ?? null, status: outcome(action, id), pending: pendingOutcome(action, titleOf(id)) };
    if (action === "sweep") {
      flyButton(button, () => client.request(client.path("/work-claims/sweep"), { method: "POST", data: {} }), focus);
      return;
    }
    const path = client.path(`/work-claims/${encodeURIComponent(id)}`);
    if (action === "claim") flyButton(button, () => client.request(`${path}/claim`, { method: "POST", data: {} }), focus);
    else if (action === "release") {
      // E5/D4 (QA-200 2026-10-08): the release binds the claim round the
      // board read (claimedAt + lifetime history length), so a stale card
      // cannot destroy a newer claim generation. A conflict surfaces the
      // server's "The claim changed since it was read" message.
      const item = items.find(entry => entry.id === id);
      const data = item ? { expectedClaimedAt: item.claimedAt,
        expectedHistoryLength: (item.history?.length ?? 0) + (Number(item.historyOmitted) || 0) } : {};
      flyButton(button, () => client.request(`${path}/release`, { method: "POST", data }), focus);
    }
    else if (action === "close" || action === "cancel") flyButton(button, () => client.request([path, action].join("/"), { method: "POST", data: {} }), focus);
    else if (action === "progress") flyButton(button, () => client.request(`${path}/update`, { method: "POST", data: { state: "in_progress" } }), focus);
    else if (action === "done") flyButton(button, () => client.request(`${path}/update`, { method: "POST", data: { state: "done" } }), focus);
    // The reviewed-policy lifecycle from the card: the holder's finish is
    // the deliver form's submit (below); the reviewer's verify is this
    // update to done, gated server-side by their recorded approval. The
    // verify carries its operation identity (#3829): the requestId is
    // derived from the claim, the delivery round and the reviewer, so a
    // retry after a lost response replays the landed outcome — bound
    // server-side to this reviewer — instead of applying twice or
    // erroring on the completed claim. The reconcile is the readback: on
    // any failure the board reloads and reports what the claim shows.
    else if (action === "verify") {
      const item = items.find(entry => entry.id === id);
      const me = viewerOf(getState(), getSession()).id;
      const title = titleOf(id);
      const reconcile = error => {
        const current = items.find(entry => entry.id === id);
        if (current?.state === "done") {
          return current.verification?.by === me
            ? uiText("board.action.outcome.verify", { title })
            : uiText("board.action.verify.already", { title });
        }
        return error?.message || uiText("board.action.verify.unconfirmed", { title });
      };
      flyButton(button, () => client.request(`${path}/update`, { method: "POST", data: claimVerifyBody(item, me) }), focus, reconcile,
        uiText("board.action.verify.unconfirmed", { title }));
    }
    // H1 (#3888): the send-back, with the Verify treatment — the same
    // reconcile shape, announcing success only when the refreshed claim
    // is actually back in progress (its verification fact names the
    // send-back when this actor took it).
    else if (action === "sendback") {
      const item = items.find(entry => entry.id === id);
      const me = viewerOf(getState(), getSession()).id;
      const title = titleOf(id);
      const reconcile = error => {
        const current = items.find(entry => entry.id === id);
        if (current?.state === "in_progress") {
          return current.verification?.by === me
            ? uiText("board.action.outcome.sendback", { title })
            : uiText("board.action.sendback.already", { title });
        }
        return error?.message || uiText("board.action.sendback.unconfirmed", { title });
      };
      flyButton(button, () => client.request(`${path}/update`, { method: "POST", data: claimSendBackBody(item, me) }), focus, reconcile,
        uiText("board.action.sendback.unconfirmed", { title }));
    }
    else if (action === "renew") {
      flyButton(button, () => client.request(`${path}/renew`, { method: "POST", data: {} }), focus);
    }
  });
  // Same in-flight treatment for form submits (BU-02): disable the submit
  // button with aria-busy; restore it only if the node survives the repaint.
  function flySubmit(form, run, focus, reconcile = null, unconfirmed = undefined) {
    const submit = form.querySelector("button[type=submit]");
    if (submit) { submit.disabled = true; submit.setAttribute("aria-busy", "true"); }
    act(run, focus, reconcile, unconfirmed).finally(() => {
      if (submit && root.contains(submit)) { submit.disabled = false; submit.removeAttribute("aria-busy"); }
    });
  }

  root.addEventListener("submit", event => {
    const linkForm = event.target.closest("[data-claim-link-pr]");
    if (linkForm && root.contains(linkForm)) {
      event.preventDefault();
      if (mutating) return;
      const id = linkForm.dataset.claimLinkPr;
      const item = items.find(entry => entry.id === id);
      if (!item || !canLinkPullRequest(item, viewerOf(getState(), getSession()), Date.now())) return;
      const pullRequest = String(new FormData(linkForm).get("pullRequest") ?? "").trim();
      if (!pullRequest) return;
      let canonicalUrl;
      try { canonicalUrl = new URL(pullRequest).href.replace(/\/$/, ""); }
      catch { note("Enter a GitHub pull request URL."); return; }
      // SEC-2: list pages carry the newest history entries plus a
      // historyOmitted count; the lifetime count is the concurrency token.
      const historyTotal = entry => (entry?.history?.length ?? 0) + (Number(entry?.historyOmitted) || 0);
      const data = { appendPullRequest: pullRequest, expectedClaimedAt: item.claimedAt, expectedHistoryLength: historyTotal(item) };
      const reconcile = error => {
        const current = items.find(entry => entry.id === id);
        const history = current?.history ?? [];
        const added = historyTotal(current) - historyTotal(item);
        const changedRound = added < 0 || added > history.length || history.slice(history.length - added)
          .some(entry => /^(claimed$|state:unclaimed$|lease_expired$|reassigned:)/.test(entry.action));
        const sameClaim = current?.owner === item.owner && current?.claimedAt === item.claimedAt && !changedRound;
        const linked = sameClaim && (current.pullRequests ?? [current.pullRequest]).some(pull => pull?.url === canonicalUrl);
        if (error?.code === "room_archived") return error.message || "This room is archived; no PR link was recorded.";
        if (error?.status === 409) return linked
          ? "Claim changed. This PR is already linked; the board is refreshed."
          : "Claim changed. The board is refreshed; check its current owner and claim before trying again.";
        if (linked) return `PR linked to '${item.title || id}'`;
        return error?.message || "Could not confirm the PR link. Check the refreshed claim before trying again.";
      };
      void act(() => {
        linkForm.setAttribute("aria-busy", "true");
        linkForm.querySelector("input").readOnly = true;
        linkForm.querySelector("button").disabled = true;
        return client.request(client.path(`/work-claims/${encodeURIComponent(id)}/update`), { method: "POST", data });
      }, { id, key: `link-pr:${id}`, pending: "Linking PR and checking the current claim…" }, reconcile).finally(() => {
        if (!root.contains(linkForm)) return;
        linkForm.removeAttribute("aria-busy");
        linkForm.querySelector("input").readOnly = false;
        linkForm.querySelector("button").disabled = false;
      });
      return;
    }
    const deliver = event.target.closest("[data-claim-deliver]");
    if (deliver && root.contains(deliver)) {
      event.preventDefault();
      if (mutating) return;
      const id = deliver.dataset.claimDeliver;
      const viewer = viewerOf(getState(), getSession());
      const item = items.find(entry => entry.id === id);
      if (!item || item.owner !== viewer.id || item.state !== "in_progress") return;
      const body = claimDeliverBody(item, new FormData(deliver), viewer.id);
      if (!body) { note(uiText("board.deliver.invalid")); return; }
      const title = item.title || id;
      // H4: the Deliver submit gets the Verify treatment — success is
      // announced only when the refreshed claim is actually delivered
      // with the submitted bundle (deliverOutcomeConfirmed). A replayed
      // or lost response that left the claim undelivered reports
      // unconfirmed instead of the canned "Delivered" text.
      const reconcile = error => {
        const current = items.find(entry => entry.id === id);
        if (deliverOutcomeConfirmed(current, body, viewer.id)) {
          return uiText("board.action.outcome.deliver", { title });
        }
        return error?.message || uiText("board.action.deliver.unconfirmed", { title });
      };
      flySubmit(deliver,
        () => client.request(client.path(`/work-claims/${encodeURIComponent(id)}/update`), { method: "POST", data: body }),
        { id, key: `deliver:${id}`, status: uiText("board.action.outcome.deliver", { title }), pending: uiText("board.action.pending.deliver", { title }) },
        reconcile, uiText("board.action.deliver.unconfirmed", { title }));
      return;
    }
    const review = event.target.closest("[data-claim-review]");
    if (review && root.contains(review)) {
      event.preventDefault();
      if (mutating) return;
      const id = review.dataset.claimReview;
      const state = getState();
      const item = items.find(entry => entry.id === id);
      if (!item || !canReviewClaim(item, viewerOf(state, getSession()), state?.members ?? {})) return;
      const fields = new FormData(review);
      const verdict = String(fields.get("verdict") ?? "");
      const summary = String(fields.get("summary") ?? "").trim();
      if (!["approve", "changes_requested", "comment"].includes(verdict) || !summary) {
        note(uiText("board.review.invalid"));
        return;
      }
      const title = item.title || id;
      // #3889: name the basis read (claimReviewBody) and reconcile the
      // announcement — "Reviewed" only when the refreshed claim carries
      // this review standing on the current basis; a stale-basis no-op
      // (200, item unchanged) reports unconfirmed instead.
      const me = viewerOf(state, getSession()).id;
      const reconcile = error => {
        const current = items.find(entry => entry.id === id);
        if (reviewOutcomeConfirmed(current, me, verdict, summary)) {
          return uiText("board.review.done", { title });
        }
        return error?.message || uiText("board.review.unconfirmed", { title });
      };
      flySubmit(review,
        () => client.request(client.path(`/work-claims/${encodeURIComponent(id)}/review`), { method: "POST", data: claimReviewBody(item, verdict, summary) }),
        { id, key: `review:${id}`, status: uiText("board.review.done", { title }), pending: uiText("board.review.pending") },
        reconcile, uiText("board.review.unconfirmed", { title }));
      return;
    }
    const created = event.target.closest("#board-new-item");
    if (created && root.contains(created)) {
      event.preventDefault();
      const data = new FormData(created);
      const body = newItemCreateBody(data);
      if (!body) return;
      const title = body.title;
      flySubmit(created, () => client.request(client.path("/work-claims"), { method: "POST", data: body }), { id: body.id, status: `Opened '${title}'`, pending: pendingOutcome("create", title) });
      return;
    }
    const form = event.target.closest("[data-claim-reassign]");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const id = form.dataset.claimReassign;
    const newOwner = new FormData(form).get("newOwner");
    if (typeof newOwner !== "string" || !newOwner) return;
    // The reassign binds the claim round the board read, like release, so a
    // stale card cannot move a newer claim generation.
    const round = items.find(entry => entry.id === id);
    const data = { newOwner, ...(round ? { expectedClaimedAt: round.claimedAt ?? null,
      expectedHistoryLength: (round.history?.length ?? 0) + (Number(round.historyOmitted) || 0) } : {}) };
    flySubmit(form, () => client.request(client.path(`/work-claims/${encodeURIComponent(id)}/reassign`), { method: "POST", data }), { id, status: outcome("reassign", id), pending: pendingOutcome("reassign", titleOf(id)) });
  });
  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-claim-cap]");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const raw = Number(new FormData(form).get("maxMemberOpenClaims"));
    if (!Number.isSafeInteger(raw)) return;
    flySubmit(form, async () => {
      const saved = await client.request(client.path("/work-claims/config"), { method: "POST", data: { maxMemberOpenClaims: raw } });
      cap = saved.maxMemberOpenClaims ?? raw;
    }, { pending: uiText("board.loading.005") });
  });

  return {
    sync() { void load(); },
    // #3795: bring one claim's card into view with its record open — the
    // destination of the card-title record link, the needs-attention Review
    // anchor, and #pr-record/work/<claimId> deep links. Loads on demand and
    // clears an active filter once if it hides the card. Returns false when
    // the claim is not on this board (unknown id, or a state the board does
    // not place) so the caller can say so honestly instead of stranding the
    // user on a board that does not contain what they opened.
    async revealClaim(id) {
      const owned = context();
      if (!owned || typeof id !== "string" || !id) return false;
      if (!items.some(item => item.id === id)) {
        if (readFlight) { try { await readFlight; } catch { /* load() below reports */ } }
        if (context() !== owned) return false;
        if (!items.some(item => item.id === id)) await load({ force: true });
        if (context() !== owned) return false;
      }
      let card = root.querySelector(`article[data-claim-id="${CSS.escape(id)}"]`);
      if (!card && filterActive(filter)) {
        filter = { q: "", mine: false };
        paint();
        card = root.querySelector(`article[data-claim-id="${CSS.escape(id)}"]`);
      }
      if (!card) return false;
      const record = card.querySelector(`details[data-claim-record="${CSS.escape(id)}"]`);
      if (record) record.open = true;
      card.scrollIntoView({ block: "center" });
      (card.querySelector("h4 a") ?? card.querySelector("h4"))?.focus({ preventScroll: true });
      return true;
    },
    async whenReady() {
      const owned = context();
      if (!owned) return false;
      try {
        if (actionFlight) await actionFlight;
        if (context() !== owned) return false;
        if (readFlight) await readFlight;
        else await load();
      } catch { return false; }
      return context() === owned && loadedContext === owned && loadedRoom === getSession()?.roomId;
    },
    reset() { operation++; mutating = false; readFlight = null; actionFlight = null; boardLoading = false; boardLoadError = false; loadedContext = null; items = []; status = null; cap = 20; reviewPolicy = null; older = false; seen = null; loadedRoom = null; pendingFocus = null; pendingStatus = ""; stick = null; filter = { q: "", mine: false }; pendingCaret = null; if (root.isConnected) root.replaceChildren(); }
  };
}
