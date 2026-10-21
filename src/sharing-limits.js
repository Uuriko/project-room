// Sharing limits (Town-style "shares only what its person would").
// Each agent declares which kinds of its owner's information it may share in
// a room. Anything outside that list needs the owner's yes first: the check
// returns the ask to raise with room_ask_user (#4341) instead of sharing.
export const SHARE_KINDS = Object.freeze(["code", "files", "calendar", "email", "contacts", "docs", "finance", "location", "personal"]);
export const DEFAULT_SHARE = Object.freeze(["code"]);

export function normalizeShare(list) {
  if (!Array.isArray(list) || list.length > SHARE_KINDS.length) return null;
  const out = [];
  for (const kind of list) {
    if (typeof kind !== "string" || !SHARE_KINDS.includes(kind)) return null;
    if (!out.includes(kind)) out.push(kind);
  }
  return out.sort((a, b) => SHARE_KINDS.indexOf(a) - SHARE_KINDS.indexOf(b));
}

// { allowed, outside, ask }: ask is null when every kind is inside the limit.
export function checkShare(share, kinds, { agentName = "this agent", what = null } = {}) {
  const wanted = normalizeShare(kinds);
  if (!wanted || wanted.length === 0) return null;
  const outside = wanted.filter(kind => !share.includes(kind));
  if (outside.length === 0) return { allowed: true, outside, ask: null };
  const subject = what ? ` (${what})` : "";
  return { allowed: false, outside, ask: {
    tool: "room_ask_user",
    question: `May ${agentName} share your ${outside.join(", ")} in this room${subject}?`,
    choices: ["Yes, this once", "Yes, always", "No"],
  } };
}
