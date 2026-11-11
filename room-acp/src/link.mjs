// Parse a Room invite link (or a bare invite code) into { apiBase, code }.
//
// The API base is never taken from the link alone (RES-0129): a link is
// trusted only when the base it names is one of the Room's own issuer
// bases below, a loopback base (local development and the in-process test
// server), or exactly the base the operator configured with --origin.
// Any other origin — including userinfo, lookalike-host, non-default-port
// and path-prefix forms of a real host — is refused, so a pasted link
// cannot redirect the redemption POST, and the credential it mints, to an
// attacker's server.
export const DEFAULT_ORIGIN = "https://room.trydemigod.com";
// The product's own doors: the direct Room origin (DEFAULT_ORIGIN; the
// same value as ROOM_ORIGIN in src/service-origin.js) and the getdasha
// entry door under its /room prefix (deploy ENTRY_ORIGIN is
// https://www.getdasha.com/room; EDGE_DOOR_HOSTS in src/service-origin.js).
export const ISSUER_BASES = Object.freeze([
  "https://room.trydemigod.com",
  "https://www.getdasha.com/room",
  "https://getdasha.com/room",
]);
const CODE = /^[A-Z]{2}-[0-9A-Z]{16,40}$/;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function parseInvite(input, { origin = null } = {}) {
  const configured = normalizeBase(origin ?? DEFAULT_ORIGIN);
  const text = String(input ?? "").trim();
  if (CODE.test(text.toUpperCase())) return { apiBase: configured, code: text.toUpperCase() };
  let url;
  try { url = new URL(text); } catch { throw new Error("expected a Room invite link like https://room.trydemigod.com/join/RM-…"); }
  if (url.username || url.password) throw new Error("invite links must not contain credentials in the URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.includes(url.hostname))) throw new Error("invite links must use https");
  const shared = url.hash.match(/^#join\/([A-Za-z0-9_-]{32,128})(?:\/.*)?$/);
  if (shared) {
    const apiBase = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    assertTrusted(apiBase, configured);
    return { apiBase, linkToken: shared[1] };
  }
  // /join/<code> and the /a/<code> agent-steps link the join page hands to agents.
  const match = url.pathname.match(/^(.*?)\/(?:join|a)\/([A-Za-z]{2}-[0-9A-Za-z]{16,40})\/?$/);
  if (!match) throw new Error("that link has no /join/<code> (or /a/<code>) part; copy the agent invite link from the Room");
  // Same contract as the CLI parser: only the share-analytics ?ref= may ride
  // along; any other query (say a pasted token) or a fragment is refused.
  if (url.hash || [...url.searchParams.keys()].some(key => key !== "ref"))
    throw new Error("invite code links carry no query (other than ?ref=) or fragment; copy the link exactly from the Room");
  const apiBase = `${url.origin}${match[1].replace(/\/+$/, "")}`;
  assertTrusted(apiBase, configured);
  return { apiBase, code: match[2].toUpperCase() };
}

function assertTrusted(apiBase, configured) {
  if (apiBase === configured || ISSUER_BASES.includes(apiBase)) return;
  try { if (LOOPBACK.includes(new URL(apiBase).hostname)) return; } catch { /* fall through to refusal */ }
  throw new Error(`invite link names ${apiBase}, which is not a Room address this bridge trusts; refusing to send the invite there. If this is your own Room deployment, pass --origin ${apiBase} to trust it explicitly`);
}

// A configured base (--origin or the default): an origin plus an optional
// fixed path prefix (the getdasha door lives under /room), https only
// except on loopback, never with credentials embedded.
export function normalizeBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid Room origin: ${value}`); }
  if (url.username || url.password) throw new Error("Room origin must not contain credentials in the URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.includes(url.hostname))) throw new Error("Room origin must use https");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
