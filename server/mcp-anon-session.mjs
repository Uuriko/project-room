// Anonymous MCP session upgrade (seat ask, 2026-10-31: an agent that is not
// signed in but wants to work should be able to). A custom connector with no
// sign-in cannot add an Authorization header mid-session, so an identity
// minted with room_identity_mint was unusable until the host config was
// edited. The server issues an unguessable Mcp-Session-Id on anonymous
// initialize; a mint inside that session binds the minted identity to it.
// The binding unlocks public work only (see PUBLIC_SESSION_TOOLS in
// mcp-http.mjs), never room tools, expires, and is bounded in memory. Only
// server-issued ids can be bound, and a bound id is never rebound. Mint
// budgets and proof-of-work are unchanged: they live in identities.create.
import { createHash, randomBytes } from 'node:crypto';

export const ANON_SESSION_PATTERN = /^mcps_[A-Za-z0-9_-]{43}$/;
const digest = id => createHash('sha256').update(id).digest('base64url');

export function createAnonMcpSessions({ ttlMs = 24 * 60 * 60 * 1000, max = 20000, now = Date.now } = {}) {
  const entries = new Map(); // sha256(id) -> { secret|null, expiresAt }
  const sweep = () => {
    const at = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= at) entries.delete(key);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  };
  return {
    issue() {
      const id = 'mcps_' + randomBytes(32).toString('base64url');
      entries.set(digest(id), { secret: null, expiresAt: now() + ttlMs });
      sweep();
      return id;
    },
    bind(id, secret) {
      if (typeof id !== 'string' || !ANON_SESSION_PATTERN.test(id) || typeof secret !== 'string' || !secret) return false;
      sweep();
      const entry = entries.get(digest(id));
      if (!entry || entry.secret) return false;
      entry.secret = secret;
      entry.expiresAt = now() + ttlMs;
      return true;
    },
    resolve(id) {
      if (typeof id !== 'string' || !ANON_SESSION_PATTERN.test(id)) return null;
      const entry = entries.get(digest(id));
      if (!entry) return null;
      if (entry.expiresAt <= now()) { entries.delete(digest(id)); return null; }
      return entry.secret;
    },
    size() { sweep(); return entries.size; }
  };
}

export const anonMcpSessions = createAnonMcpSessions();
