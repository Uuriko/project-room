class GuestAgentLinkError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GuestAgentLinkError(status, code, message); };

// Human share tokens stay 43 chars. Guest-agent tokens are a different shape so
// they can never be redeemed through /api/share-links or #join/.
export const GUEST_AGENT_TOKEN_PREFIX = "ga1.";
export const GUEST_AGENT_TOKEN_PATTERN = /^ga1\.[A-Za-z0-9_-]{43}$/;
export const HUMAN_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const GUEST_AGENT_HASH_PATH = "#agent-join/";
export const HUMAN_SHARE_HASH_PATH = "#join/";
export const GUEST_AGENT_KIND = "agent";
export const GUEST_AGENT_PERMISSIONS = Object.freeze([]);
export const GUEST_AGENT_TTL_MS = 2 * 60 * 60 * 1000;
export const GUEST_AGENT_MAX_JOINS = 10;
export const GUEST_AGENT_STATUS = "designed";
const NOT_LIVE = "Guest-agent links are designed, not live. Use a chat packet or an owner-issued agent key.";

export function classifyJoinToken(token) {
  if (typeof token !== "string") return "invalid";
  if (GUEST_AGENT_TOKEN_PATTERN.test(token)) return "guest-agent";
  if (HUMAN_SHARE_TOKEN_PATTERN.test(token)) return "human-share";
  return "invalid";
}

export function guestAgentLinkContract() {
  return {
    status: GUEST_AGENT_STATUS,
    kind: GUEST_AGENT_KIND,
    permissions: [...GUEST_AGENT_PERMISSIONS],
    access: "read_chat",
    ttlMs: GUEST_AGENT_TTL_MS,
    maxJoins: GUEST_AGENT_MAX_JOINS,
    hashPath: GUEST_AGENT_HASH_PATH,
    tokenPrefix: GUEST_AGENT_TOKEN_PREFIX,
    account: false,
    separateFromHumanShareLinks: true,
    mint: "not_implemented"
  };
}

function assertGuestAgentToken(token) {
  const kind = classifyJoinToken(token);
  if (kind === "human-share") fail(422, "wrong_link_kind", "Human invitation links are not agent credentials.");
  if (kind !== "guest-agent") fail(410, "link_unavailable", "This guest-agent link is not valid.");
}

export function previewGuestAgentLink(token) {
  assertGuestAgentToken(token);
  fail(501, "guest_agent_link_not_implemented", NOT_LIVE);
}

export function joinGuestAgentLink(token) {
  assertGuestAgentToken(token);
  fail(501, "guest_agent_link_not_implemented", NOT_LIVE);
}

export function mintGuestAgentLink() {
  fail(501, "guest_agent_link_not_implemented", "Guest-agent link mint is not implemented. No member is created.");
}
