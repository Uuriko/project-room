// Open-PR throughput signal.
//
// The cap (default 5) counts open pull requests an agent already has linked
// to claims they own. Crossing it does not refuse a claim, a reassign, or a
// pull link. The claim response and room_needs_me carry a steer: finish,
// rebase, or land those pulls. Someone else who can reassign (the room
// owner, or a member with manage_claims) is told on the same response and
// on their own room_needs_me read.
//
// A pull counts while its recorded outcome is still open. merged and closed
// outcomes do not. The same URL on two claims counts once.

import { ownMember } from "../src/events.js";

export const DEFAULT_OPEN_PR_CAP = 5;
export const THROUGHPUT_LABEL = "throughput";

const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

export function pullIdentity(entry) {
  const url = typeof entry === "string" ? entry : entry?.url;
  if (typeof url !== "string") return null;
  const match = PULL_URL.exec(url);
  if (!match) return null;
  return {
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
  };
}

export function isOpenPull(entry) {
  if (typeof entry === "string") return pullIdentity(entry) !== null;
  if (entry === null || typeof entry !== "object") return false;
  if (entry.outcome === "merged" || entry.outcome === "closed") return false;
  return pullIdentity(entry) !== null;
}

function linksOf(item) {
  const listed = Array.isArray(item?.pullRequests) ? item.pullRequests : [];
  if (listed.length) return listed;
  return item?.pullRequest ? [item.pullRequest] : [];
}

// Distinct open pulls owned by memberId, number order.
export function openPullsFor(claims, memberId) {
  const byUrl = new Map();
  if (!Array.isArray(claims) || typeof memberId !== "string" || memberId.length === 0) return [];
  for (const item of claims) {
    if (!item || item.owner !== memberId) continue;
    for (const entry of linksOf(item)) {
      if (!isOpenPull(entry)) continue;
      const id = pullIdentity(entry);
      if (!byUrl.has(id.url)) byUrl.set(id.url, { ...id, claimId: typeof item.id === "string" ? item.id : null });
    }
  }
  return [...byUrl.values()].sort((a, b) => a.number - b.number || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// Room owner, then other active manage_claims members. The subject is omitted:
// telling them is the claim response, and they cannot reassign their own load
// to themselves.
export function coordinatorsFor(authority, memberId) {
  if (!authority || typeof memberId !== "string") return [];
  const ids = [];
  const ownerId = typeof authority.ownerId === "string" && authority.ownerId.length > 0 ? authority.ownerId : null;
  if (ownerId && ownerId !== memberId) ids.push(ownerId);
  const members = authority.members && typeof authority.members === "object" ? authority.members : {};
  const managers = Object.keys(members).filter(id => {
    if (id === memberId || id === ownerId) return false;
    const member = ownMember(members, id);
    if (!member || member.active === false) return false;
    return Array.isArray(member.permissions) && member.permissions.includes("manage_claims");
  }).sort();
  return [...ids, ...managers];
}

export function steerText({ open, cap, told }) {
  const base = `You have ${open} open pull requests. The cap is ${cap}, a throughput signal. Finish, rebase, or land your own open pull requests. You can keep working.`;
  return told ? `${base} The room coordinator has been told and can reassign work.` : base;
}

// Frozen signal for a claim response. over is open > cap. At the cap, over
// is false and steer is null: the counts are still there so the agent can
// see them. blocking is always false.
export function openPrThroughput(claims, memberId, authority = null, cap = DEFAULT_OPEN_PR_CAP) {
  const pulls = openPullsFor(claims, memberId);
  const open = pulls.length;
  const over = open > cap;
  const coordinatorMemberIds = over ? coordinatorsFor(authority, memberId) : [];
  const told = coordinatorMemberIds.length > 0;
  const shown = pulls.slice(0, 20);
  return Object.freeze({
    cap,
    open,
    over,
    blocking: false,
    steer: over ? steerText({ open, cap, told }) : null,
    pulls: Object.freeze(shown.map(pull => Object.freeze({ ...pull }))),
    ...(pulls.length > shown.length ? { pullsTruncated: true } : {}),
    coordinatorTold: told,
    coordinatorMemberIds: Object.freeze([...coordinatorMemberIds]),
  });
}

// Standing room_needs_me section for the agent who is over the cap.
// Absent when they are at or under it, so a quiet inbox stays quiet.
export function openPrThroughputSection(roomId, memberId, claims) {
  const signal = openPrThroughput(claims, memberId);
  if (!signal.over) return null;
  return {
    roomId,
    cap: signal.cap,
    open: signal.open,
    blocking: false,
    steer: signal.steer,
    pulls: signal.pulls,
    next: "Finish, rebase, or land these pull requests. You can still claim work.",
  };
}

// Standing room_needs_me section for a room owner or manage_claims member.
// Lists other members over the cap, so they can reassign. Absent when there
// is nobody to move.
export function coordinatorThroughputSection(roomId, memberId, authority, claims) {
  const isOwner = typeof authority?.ownerId === "string" && authority.ownerId === memberId;
  const perms = ownMember(authority?.members, memberId)?.permissions ?? [];
  const isManager = Array.isArray(perms) && perms.includes("manage_claims");
  if (!isOwner && !isManager) return null;
  if (!Array.isArray(claims)) return null;
  const owners = [...new Set(claims.map(item => item?.owner).filter(id => typeof id === "string" && id.length > 0 && id !== memberId))].sort();
  const members = [];
  for (const owner of owners) {
    const signal = openPrThroughput(claims, owner);
    if (!signal.over) continue;
    members.push({ memberId: owner, open: signal.open, cap: signal.cap, pulls: signal.pulls });
  }
  if (!members.length) return null;
  return {
    roomId,
    cap: DEFAULT_OPEN_PR_CAP,
    members,
    next: "Reassign work from these members, or leave it. Their claims were not refused. They were asked to finish, rebase, or land their open pull requests.",
  };
}
