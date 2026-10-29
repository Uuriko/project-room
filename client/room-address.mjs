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
// Anything ambiguous is rejected with candidates instead of guessed: a token that is one
// member's id and another member's display name is ambiguous too. A whole string that
// equals a display name (names may contain ":" or "/") is a member address first.

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

function lookup(active, person) {
  const candidates = candidatesFor(active, person);
  const ids = [...new Set(candidates.map(c => c.memberId))];
  if (ids.length === 1) return { memberId: ids[0] };
  return ids.length > 1 ? { error: "ambiguous", candidates } : { error: "unknown_member" };
}

export function resolveAddress(input, { members = [], claims = [] } = {}) {
  const active = (Array.isArray(members) ? members : []).filter(row => row && row.active !== false && typeof idOf(row) === "string");
  if (typeof input === "string") {
    const whole = input.trim().replace(/^@/, "");
    if (whole && (whole.includes(":") || whole.includes("/")) && candidatesFor(active, whole).length) {
      const hit = lookup(active, whole);
      return hit.memberId ? { ok: true, memberId: hit.memberId } : { ok: false, ...hit };
    }
  }
  const parsed = parseAddress(input);
  if (!parsed) return { ok: false, error: "invalid_address" };
  const hit = lookup(active, parsed.person);
  if (!hit.memberId) return { ok: false, ...hit };
  const memberId = hit.memberId;
  if (parsed.kind === "member") return { ok: true, memberId };
  const live = (Array.isArray(claims) ? claims : []).filter(item => item && item.owner === memberId && LIVE.has(item.state));
  if (parsed.kind === "session") {
    const owned = live.find(item => item.id === parsed.session || item.workItemId === parsed.session);
    if (!owned) return { ok: false, error: "session_not_owned", memberId };
    // claimId is the Board claim; workItemId only when the claim is linked to a real work item.
    return { ok: true, memberId, claimId: owned.id, ...(typeof owned.workItemId === "string" && owned.workItemId ? { workItemId: owned.workItemId } : {}) };
  }
  const inRepo = live.filter(item => repoMatches(item.repo, parsed.repo));
  if (!inRepo.length) return { ok: false, error: "not_in_repo", memberId };
  const repos = [...new Set(inRepo.map(item => lc(item.repo)))];
  if (repos.length > 1) return { ok: false, error: "ambiguous_repo", memberId, repos };
  return { ok: true, memberId, repo: inRepo[0].repo };
}
