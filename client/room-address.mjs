// Reason-take-5: one address syntax for "who do I mean", resolved only
// against data the room already returns (the presence roster's members and
// the Board's claims). It adds no identity, no routing and no new tool: the
// result is a memberId (plus an optional workItemId) that existing commands
// such as room_reply toMemberId or room_request_reply already accept.
//
//   Name | @Name | ai_xxx            -> that member
//   Name/<workItemId>                 -> that member, only if they own the session
//   repo:Name | owner/repo:Name       -> that member, only if they hold a live claim in that repo
//
// Anything ambiguous is rejected with candidates instead of guessed.
import { resolveMemberId } from "./swarm-brief.mjs";

const LIVE = new Set(["claimed", "in_progress", "blocked"]); // same as ACTIVE_CLAIM_STATES
const idOf = row => row?.memberId ?? row?.id;
const nameOf = row => row?.displayName ?? row?.name;
const lc = value => String(value).toLowerCase();

export function parseAddress(input) {
  if (typeof input !== "string") return null;
  const text = input.trim().replace(/^@/, "");
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return null;
  const colon = text.lastIndexOf(":");
  if (colon > 0 && !/^https?:/i.test(text)) {
    const repo = text.slice(0, colon).trim();
    const person = text.slice(colon + 1).trim();
    if (!person || !/^[\w.-]+(\/[\w.-]+)?$/.test(repo)) return null;
    return { kind: "repo", repo, person };
  }
  const slash = text.indexOf("/");
  if (slash > 0) {
    const person = text.slice(0, slash).trim();
    const session = text.slice(slash + 1).trim();
    if (!person || !session || session.includes("/")) return null;
    return { kind: "session", person, session };
  }
  return { kind: "member", person: text };
}

function candidatesFor(members, person) {
  return members.filter(row => idOf(row) === person || (typeof nameOf(row) === "string" && lc(nameOf(row)) === lc(person)))
    .map(row => ({ memberId: idOf(row), displayName: nameOf(row) ?? null }));
}

const repoMatches = (claimRepo, wanted) => {
  if (typeof claimRepo !== "string" || !claimRepo) return false;
  const a = lc(claimRepo), b = lc(wanted);
  return b.includes("/") ? a === b : a === b || a.endsWith("/" + b);
};

export function resolveAddress(input, { members = [], claims = [] } = {}) {
  const parsed = parseAddress(input);
  if (!parsed) return { ok: false, error: "invalid_address" };
  const active = (Array.isArray(members) ? members : []).filter(row => row && row.active !== false && typeof idOf(row) === "string");
  const memberId = resolveMemberId(active, parsed.person);
  if (!memberId) {
    const candidates = candidatesFor(active, parsed.person);
    return candidates.length > 1 ? { ok: false, error: "ambiguous", candidates } : { ok: false, error: "unknown_member" };
  }
  if (parsed.kind === "member") return { ok: true, memberId };
  const live = (Array.isArray(claims) ? claims : []).filter(item => item && item.owner === memberId && LIVE.has(item.state));
  if (parsed.kind === "session") {
    const owned = live.find(item => item.id === parsed.session || item.workItemId === parsed.session);
    return owned ? { ok: true, memberId, workItemId: owned.workItemId ?? owned.id } : { ok: false, error: "session_not_owned", memberId };
  }
  const inRepo = live.filter(item => repoMatches(item.repo, parsed.repo));
  if (!inRepo.length) return { ok: false, error: "not_in_repo", memberId };
  const repos = [...new Set(inRepo.map(item => lc(item.repo)))];
  if (repos.length > 1) return { ok: false, error: "ambiguous_repo", memberId, repos };
  return { ok: true, memberId, repo: inRepo[0].repo };
}
