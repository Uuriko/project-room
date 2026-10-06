// Hard Work lane (docs/HARD-WORK.md): a pure, read-only view over work-claims
// Board items. It answers four questions from Board data only: which hard
// items are open and how they are paired, which need a reviewer or are stuck,
// what each member's real mix of closed work is, and which hard item a member
// should take next with which partner. No writes, no clock reads, no network;
// scripts/hard-work.mjs is the CLI around it.
//
// The lane marker is a tag: "hard" (or the earlier "hard-problem"). Tier is a
// tag H1, H2 or H3 (or an "H2:" title prefix). Pairing comes from tags
// "build-<memberId>" and "rev-<memberId>"; items created before those tags
// existed are read from the create note ("Reviewer: Fo", "Author: X").
export const LANE_TAGS = Object.freeze(["hard", "hard-problem"]);
export const TIERS = Object.freeze(["H1", "H2", "H3"]);
export const OPEN_STATES = Object.freeze(["unclaimed", "claimed", "in_progress", "blocked"]);
const ACTIVE_STATES = ["claimed", "in_progress", "blocked"];
const HOUR = 3600 * 1000;

const tagsOf = item => (Array.isArray(item?.tags) ? item.tags.map(tag => String(tag)) : []);
const lower = value => String(value).toLowerCase();
const msOf = value => {
  const ms = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
};

export function isHard(item) {
  const tags = tagsOf(item).map(lower);
  return LANE_TAGS.some(tag => tags.includes(tag)) || (tierOf(item) !== null && tags.some(tag => tag.startsWith("rev-")));
}

export function tierOf(item) {
  for (const tag of tagsOf(item)) {
    const upper = tag.toUpperCase();
    if (TIERS.includes(upper)) return upper;
  }
  const match = /^\s*\[?(H[123])\b/i.exec(String(item?.title ?? ""));
  return match ? match[1].toUpperCase() : null;
}

const createNoteOf = item => (Array.isArray(item?.history) ? item.history.find(entry => entry?.action === "created")?.note ?? "" : "");

// roster: [{ id, handle }]. Returns the member id for a handle, or null when
// the handle matches nobody or more than one member (never guess).
export function resolveHandle(text, roster = []) {
  const wanted = lower(String(text ?? "").trim().replace(/^@/, ""));
  if (!wanted) return null;
  const exact = roster.filter(member => lower(member.handle ?? "") === wanted);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const byId = roster.find(member => member.id === text);
  if (byId) return byId.id;
  // A unique handle prefix ("Claude" for "Claude (Cowork)"); ambiguous is null.
  const prefixed = roster.filter(member => lower(member.handle ?? "").startsWith(`${wanted} `));
  return prefixed.length === 1 ? prefixed[0].id : null;
}

const candidatesIn = (phrase, roster) => String(phrase ?? "")
  .split(/\s*(?:,|\/|\bor\b|\band\b|\+)\s*/i)
  .map(part => resolveHandle(part, roster))
  .filter(Boolean);

// Tags hold at most 32 characters, so a long member id is written as a handle
// slug ("rev-codexqa" for "Codex QA"). An exact id wins; an unknown or
// ambiguous slug is kept as written.
export const handleSlug = handle => lower(handle ?? "").replace(/[^a-z0-9]/g, "");
function memberOfTag(value, roster) {
  if (roster.some(member => member.id === value)) return value;
  const matches = roster.filter(member => handleSlug(member.handle) === lower(value));
  return matches.length === 1 ? matches[0].id : value;
}

const NOTE_FIELDS = {
  reviewer: /\b(?:reviewer|reviewed by)\s*:\s*([^.;\n(]+)/i,
  builder: /\b(?:builder|author|offered to|suggested author)\s*:?\s+([^.;\n(]+)/i
};

// { builder, reviewer, builders, source }. Tags win over the create note.
export function pairingOf(item, roster = []) {
  const tags = tagsOf(item);
  const tagged = prefix => tags.filter(tag => lower(tag).startsWith(prefix)).map(tag => tag.slice(prefix.length)).filter(Boolean);
  const revTags = tagged("rev-").map(value => memberOfTag(value, roster));
  const buildTags = tagged("build-").map(value => memberOfTag(value, roster));
  if (revTags.length || buildTags.length) {
    return { builder: buildTags[0] ?? null, builders: buildTags, reviewer: revTags[0] ?? null, source: "tags" };
  }
  const note = createNoteOf(item);
  const reviewerMatch = NOTE_FIELDS.reviewer.exec(note);
  const builderMatch = NOTE_FIELDS.builder.exec(note);
  const reviewers = reviewerMatch ? candidatesIn(reviewerMatch[1], roster) : [];
  const builders = builderMatch ? candidatesIn(builderMatch[1], roster) : [];
  const source = reviewers.length || builders.length ? "note" : null;
  return { builder: builders[0] ?? null, builders, reviewer: reviewers[0] ?? null, source };
}

export function lastActivityMs(item) {
  const stamps = (Array.isArray(item?.history) ? item.history : []).map(entry => msOf(entry?.at)).filter(ms => ms !== null);
  const updated = msOf(item?.updatedAt);
  if (updated !== null) stamps.push(updated);
  return stamps.length ? Math.max(...stamps) : null;
}

export function doneAtMs(item) {
  if (item?.state !== "done") return null;
  const history = Array.isArray(item.history) ? item.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.action === "state:done" || entry?.action === "pr_merged") return msOf(entry.at);
  }
  return msOf(item.updatedAt);
}

const approversOf = item => {
  const ids = new Set();
  for (const review of Array.isArray(item?.reviews) ? item.reviews : []) {
    if (review?.verdict === "approve" && review.memberId && review.memberId !== item.owner) ids.add(review.memberId);
  }
  if (item?.reviewedBy && item.reviewedBy !== item.owner) ids.add(item.reviewedBy);
  return [...ids];
};

// The open lane. Flags are facts read from the Board, never guesses:
//   no-reviewer          no reviewer is named (tags or create note)
//   reviewer-is-owner    the named reviewer holds the claim
//   self-close-allowed   reviewPolicy is not distinct_member/independent_principal
//   stuck                claimed/in_progress/blocked with no history for stuckHours
//   blocked              state is blocked
//   reviewer-overloaded  the named reviewer already reviews more than maxReviewerLoad
//                        claimed items (unclaimed suggestions do not count; the
//                        builder confirms or swaps the reviewer at claim time)
export function laneView(items, { now, roster = [], stuckHours = 12, maxReviewerLoad = 2 } = {}) {
  const nowMs = msOf(now);
  if (nowMs === null) throw new TypeError("laneView needs now");
  const open = (Array.isArray(items) ? items : []).filter(item => isHard(item) && OPEN_STATES.includes(item.state));
  const reviewerLoad = {};
  const reviewerNamed = {};
  const rows = open.map(item => {
    const pairing = pairingOf(item, roster);
    if (pairing.reviewer) {
      reviewerNamed[pairing.reviewer] = (reviewerNamed[pairing.reviewer] ?? 0) + 1;
      if (ACTIVE_STATES.includes(item.state)) reviewerLoad[pairing.reviewer] = (reviewerLoad[pairing.reviewer] ?? 0) + 1;
    }
    const last = lastActivityMs(item);
    const idleHours = last === null ? null : Math.floor((nowMs - last) / HOUR);
    const flags = [];
    if (!pairing.reviewer) flags.push("no-reviewer");
    if (pairing.reviewer && item.owner && pairing.reviewer === item.owner) flags.push("reviewer-is-owner");
    if (!["distinct_member", "independent_principal"].includes(item.reviewPolicy)) flags.push("self-close-allowed");
    if (item.state === "blocked") flags.push("blocked");
    if (ACTIVE_STATES.includes(item.state) && idleHours !== null && idleHours >= stuckHours) flags.push("stuck");
    return { id: item.id, title: item.title ?? item.id, tier: tierOf(item), state: item.state, owner: item.owner ?? null,
      builder: pairing.builder, reviewer: pairing.reviewer, pairingSource: pairing.source, idleHours,
      pullRequest: item.pullRequest?.url ?? null, dependsOn: Array.isArray(item.dependsOn) ? [...item.dependsOn] : [], flags };
  });
  const overloaded = Object.entries(reviewerLoad).filter(([, count]) => count > maxReviewerLoad).map(([id]) => id).sort();
  for (const row of rows) if (row.reviewer && overloaded.includes(row.reviewer) && ACTIVE_STATES.includes(row.state)) row.flags.push("reviewer-overloaded");
  const tierRank = tier => (tier ? TIERS.indexOf(tier) : -1);
  rows.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || a.id.localeCompare(b.id));
  const byTier = { H3: 0, H2: 0, H1: 0, untiered: 0 };
  for (const row of rows) byTier[row.tier ?? "untiered"] += 1;
  return {
    open: rows,
    byTier,
    needsPair: rows.filter(row => row.flags.includes("no-reviewer") || row.flags.includes("reviewer-is-owner")).map(row => row.id),
    stuck: rows.filter(row => row.flags.includes("stuck") || row.flags.includes("blocked")).map(row => row.id),
    reviewerLoad,
    reviewerNamed,
    overloadedReviewers: overloaded
  };
}

// Real counts per member over done items in [since, until):
//   hardBuilt     hard items the member owned at done
//   hardReviewed  hard items the member approved (Board review) or attested
//   otherClosed   non-hard items the member owned at done
//   easySinceHard non-hard closes after the member's latest hard build/review
export function workMix(items, { since = null, until = null } = {}) {
  const sinceMs = since === null ? null : msOf(since);
  const untilMs = until === null ? null : msOf(until);
  const inWindow = ms => ms !== null && (sinceMs === null || ms >= sinceMs) && (untilMs === null || ms < untilMs);
  const members = {};
  const row = id => (members[id] ??= { hardBuilt: 0, hardReviewed: 0, otherClosed: 0, easySinceHard: 0, lastHardAt: null });
  const done = (Array.isArray(items) ? items : []).map(item => ({ item, at: doneAtMs(item) })).filter(entry => inWindow(entry.at));
  done.sort((a, b) => a.at - b.at);
  for (const { item, at } of done) {
    const hard = isHard(item);
    if (item.owner) {
      const owner = row(item.owner);
      if (hard) { owner.hardBuilt += 1; owner.lastHardAt = at; owner.easySinceHard = 0; }
      else { owner.otherClosed += 1; owner.easySinceHard += 1; }
    }
    if (hard) {
      for (const reviewer of approversOf(item)) {
        const entry = row(reviewer);
        entry.hardReviewed += 1;
        entry.lastHardAt = at;
        entry.easySinceHard = 0;
      }
    }
  }
  for (const entry of Object.values(members)) entry.lastHardAt = entry.lastHardAt === null ? null : new Date(entry.lastHardAt).toISOString();
  return members;
}

// The next hard item for memberId, plus a partner. Candidates are unclaimed
// hard items whose dependsOn are all done and whose named reviewer is not the
// member. An item that names a different builder is skipped until it has sat
// unclaimed for reserveHours. Members owing hard work (3+ easy closes since
// their last hard one) are steered to the highest tier.
export function nextFor(items, memberId, { now, roster = [], reviewers = [], reserveHours = 24, maxReviewerLoad = 2 } = {}) {
  const nowMs = msOf(now);
  if (nowMs === null) throw new TypeError("nextFor needs now");
  const list = Array.isArray(items) ? items : [];
  const doneIds = new Set(list.filter(item => item.state === "done").map(item => item.id));
  const view = laneView(list, { now: nowMs, roster, maxReviewerLoad });
  const owes = (workMix(list)[memberId]?.easySinceHard ?? 0) >= 3;
  const scored = [];
  for (const item of list) {
    if (item.state !== "unclaimed" || !isHard(item)) continue;
    if ((item.dependsOn ?? []).some(dep => !doneIds.has(dep))) continue;
    const pairing = pairingOf(item, roster);
    if (pairing.reviewer === memberId) continue;
    const created = msOf(item.history?.find(entry => entry?.action === "created")?.at) ?? lastActivityMs(item) ?? nowMs;
    const ageHours = Math.max(0, (nowMs - created) / HOUR);
    const namedHere = pairing.builders.includes(memberId);
    if (pairing.builders.length && !namedHere && ageHours < reserveHours) continue;
    const tier = tierOf(item);
    const rank = tier ? TIERS.indexOf(tier) + 1 : 1;
    const score = (namedHere ? 100 : 10) + rank * (owes ? 20 : 2) + Math.min(ageHours, 72) / 24;
    scored.push({ item, pairing, score, tier, namedHere });
  }
  scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const pick = scored[0];
  if (!pick) return null;
  let partner = pick.pairing.reviewer && pick.pairing.reviewer !== memberId ? pick.pairing.reviewer : null;
  let partnerSource = partner ? "named" : null;
  if (!partner) {
    const pool = reviewers.filter(id => id !== memberId && (view.reviewerLoad[id] ?? 0) < maxReviewerLoad);
    pool.sort((a, b) => (view.reviewerLoad[a] ?? 0) - (view.reviewerLoad[b] ?? 0) || a.localeCompare(b));
    partner = pool[0] ?? null;
    partnerSource = partner ? "least-loaded" : null;
  }
  const reason = [pick.namedHere ? "names you as builder" : pick.pairing.builders.length ? `reserved builder idle ${reserveHours}h+` : "open to any builder",
    pick.tier ? `tier ${pick.tier}` : "untiered", owes ? "you have 3+ easy closes since your last hard one" : null].filter(Boolean).join("; ");
  return { id: pick.item.id, title: pick.item.title ?? pick.item.id, tier: pick.tier, partner, partnerSource, reason };
}

const nameOf = (id, roster) => (id ? roster.find(member => member.id === id)?.handle ?? id : "-");

export function formatLane(view, roster = []) {
  const lines = [`Hard lane: ${view.open.length} open (H3 ${view.byTier.H3}, H2 ${view.byTier.H2}, H1 ${view.byTier.H1}, untiered ${view.byTier.untiered})`];
  for (const row of view.open) {
    lines.push(`- ${row.tier ?? "H?"} ${row.id} [${row.state}] builder ${nameOf(row.owner ?? row.builder, roster)} / reviewer ${nameOf(row.reviewer, roster)}${row.flags.length ? `  !${row.flags.join(",")}` : ""}`);
  }
  const named = Object.entries(view.reviewerNamed ?? {}).filter(([, count]) => count > 2);
  if (named.length) lines.push(`Named as reviewer on 3+ open items (confirm or swap at claim): ${named.map(([id, count]) => `${nameOf(id, roster)} (${count})`).join(", ")}`);
  if (view.overloadedReviewers.length) lines.push(`Reviewer rotation needed: ${view.overloadedReviewers.map(id => `${nameOf(id, roster)} (${view.reviewerLoad[id]})`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export function formatMix(mix, roster = []) {
  const rows = Object.entries(mix).sort(([, a], [, b]) => (b.hardBuilt + b.hardReviewed) - (a.hardBuilt + a.hardReviewed) || b.otherClosed - a.otherClosed);
  const lines = ["member | hard built | hard reviewed | other closed | easy since last hard"];
  for (const [id, entry] of rows) lines.push(`${nameOf(id, roster)} | ${entry.hardBuilt} | ${entry.hardReviewed} | ${entry.otherClosed} | ${entry.easySinceHard}`);
  return `${lines.join("\n")}\n`;
}
