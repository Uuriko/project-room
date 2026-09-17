// Guest agent invite links (B011). A pure invite-link manager with
// expiry and single-use hardening: each link carries a token, an expiry
// time, a max-use count (default 1), and a used count. redeem() validates
// expiry and usage, increments the counter, and refuses expired or
// exhausted links. All state is caller-owned (a Map); time is injectable
// for tests. The module is pure; default token generation uses node:crypto.
// Token generation uses a caller-supplied random source for test determinism;
// when none is supplied, tokens come from crypto.randomBytes (never Math.random).
// Frozen outputs; malformed inputs throw InviteError. HTTP route wiring is a
// later slice.
import { randomBytes as nodeRandomBytes } from "node:crypto";
class InviteError extends Error { constructor(code, message) { super(message); this.name = "InviteError"; this.code = code; } }
const fail = (code, message) => { throw new InviteError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_invite", message); };
// Create an invite manager. store is a caller-owned Map (token -> invite).
// randomBytes is a caller-supplied function returning a hex string.
export function createInvites({ store, randomBytes, defaultTtlMs } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(randomBytes === undefined || typeof randomBytes === "function", "randomBytes must be a function if given");
  const ttl = defaultTtlMs ?? 24 * 60 * 60 * 1000;
  check(Number.isFinite(ttl) && ttl > 0, "defaultTtlMs must be positive");
  const invites = store ?? new Map();
  const gen = randomBytes ?? (() => nodeRandomBytes(8).toString("hex"));
  const nowMs = now => {
    const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
    check(!Number.isNaN(at), "now must be parseable");
    return at;
  };
  // Issue a new invite link. Returns the invite record.
  const issue = ({ room, maxUses, ttlMs, note, now } = {}) => {
    check(typeof room === "string" && room.length > 0, "room must be a non-empty string");
    const uses = maxUses ?? 1;
    check(Number.isInteger(uses) && uses >= 1, "maxUses must be a positive integer");
    const life = ttlMs ?? ttl;
    check(Number.isFinite(life) && life > 0, "ttlMs must be positive");
    check(note === undefined || (typeof note === "string" && note.length <= 500), "note must be ≤500 chars");
    const at = nowMs(now);
    const token = gen();
    check(typeof token === "string" && token.length >= 8, "randomBytes must return a string of ≥8 chars");
    check(!invites.has(token), "token collision; retry");
    const invite = Object.freeze({ token, room, maxUses: uses, usedCount: 0,
      issuedAt: new Date(at).toISOString(), expiresAt: new Date(at + life).toISOString(),
      note: note ?? null });
    invites.set(token, invite);
    return invite;
  };
  // Redeem a token. Returns the updated invite, or throws if expired/exhausted/unknown.
  const redeem = (token, { now } = {}) => {
    check(typeof token === "string" && token.length > 0, "token must be a non-empty string");
    check(invites.has(token), "unknown invite token");
    const at = nowMs(now);
    const invite = invites.get(token);
    if (at > new Date(invite.expiresAt).getTime()) fail("invite_expired", `invite for room "${invite.room}" expired`);
    if (invite.usedCount >= invite.maxUses) fail("invite_exhausted", `invite for room "${invite.room}" already used`);
    const updated = Object.freeze({ ...invite, usedCount: invite.usedCount + 1 });
    invites.set(token, updated);
    return updated;
  };
  // Revoke a token immediately.
  const revoke = token => {
    check(typeof token === "string" && invites.has(token), "unknown invite token");
    invites.delete(token);
  };
  return Object.freeze({ issue, redeem, revoke, size: () => invites.size });
}
export { InviteError };
