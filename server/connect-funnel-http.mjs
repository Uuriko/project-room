// Connect funnel metrics for the HTTP-API transport (flag
// ROOM_CONNECT_FUNNEL_HTTP, off by default).
//
// PR #5933 (server/connect-funnel.mjs, flag ROOM_CONNECT_FUNNEL) measures the
// four connect-funnel measures for MCP journeys only: its observer is hooked
// into the MCP node writer and only sees JSON-RPC `initialize` / `tools/call`
// messages. But the server's own new-agent onboarding directs agents to the
// HTTP API (server/http.mjs join guidance: `Authorization: Bearer <pri_
// secret> on /api/rooms/${roomId}/…`, `Orient: GET
// /api/rooms/${roomId}/activation-pack`, `Read the room: GET
// /api/rooms/${roomId}?view=work`), and an agent that connects, reads, posts
// and re-reads entirely over HTTP (the room-acp / raw-HTTP path) produces no
// funnel row there. This module is that missing half. It uses the same
// aggregate shape as #5933's summary() and the same privacy shape — per new
// agent connection we record only timestamps under an opaque key:
// sha256(per-database random salt + bearer). No token, account, name, IP,
// user agent, room id or body is stored; the salt never leaves the database.
// Separate tables (connect_funnel_http*) let the two PRs compose in either
// order without collision.
//
// Steps (all timestamps from the observer's clock, first success wins):
//   connected  first successful (2xx) authenticated HTTP-API request seen
//              for an agent bearer (pri_ / ga1. / rak_ / oat_ / iat_)
//   firstRead  first successful GET on a room read route
//   roundTrip  first successful read after a successful message post
//              (POST /api/rooms/:id/commands with type `message.posted`):
//              the agent saw the room after speaking in it
//
// The observer is read-only toward the request path: it never throws, never
// mutates its input, and its result is never used to answer a request. When
// the flag is off nothing is constructed (httpConnectFunnelIfEnabled returns
// null) and no table is created.
import { createHash, randomBytes } from 'node:crypto';

export const CONNECT_FUNNEL_HTTP_FLAG = 'ROOM_CONNECT_FUNNEL_HTTP';
export const httpConnectFunnelEnabled = (env = process.env) => env[CONNECT_FUNNEL_HTTP_FLAG] === '1';

// Agent credential prefixes at the pin: pri_ identity secrets
// (server/agent-identities.mjs), ga1. guest-agent tokens
// (server/guest-agent-links.mjs), rak_ agent API keys
// (server/agent-api-keys.mjs), oat_/iat_ OAuth tokens (server/http.mjs MCP
// bearer gate). Human browser sessions do not use a Bearer agent credential
// and are never counted.
const AGENT_BEARER_PREFIXES = ['pri_', 'ga1.', 'rak_', 'oat_', 'iat_'];

const bearerToken = authorization => {
  const m = /^bearer\s+(\S+)\s*$/i.exec(String(authorization ?? ''));
  return m ? m[1] : null;
};
export const isAgentBearer = authorization => {
  const token = bearerToken(authorization);
  return token !== null && AGENT_BEARER_PREFIXES.some(prefix => token.startsWith(prefix));
};

// Room routes (the `route` segment matched by the room-route table in
// server/http.mjs) whose successful GET is an authenticated read of the room.
// `null` is the room root itself (GET /api/rooms/:id, e.g. ?view=work).
// `stream` is deliberately absent: it is a long-lived subscription whose
// completion the response path cannot time honestly.
const READ_ROUTES = new Set([
  null, 'events', 'context', 'conversation', 'activation-pack', 'capabilities',
  'work-context', 'work-changes', 'work-discussion', 'work-result',
  'work-sessions', 'return-brief', 'agent-inbox', 'activity', 'mentions',
  'open-questions', 'directory', 'opportunities', 'needs-attention',
  'read-horizon', 'notifications', 'usage', 'charter', 'public-face',
  'reply-context', 'reply-history', 'search', 'pins',
]);

// Classify one completed HTTP-API request. Returns 'read', 'post',
// 'connect' (a successful authenticated agent request that is neither), or
// null (not counted: failed, or not a room-route request shape we know).
export function classifyHttpFunnelEvent({ method, route, status, commandType } = {}) {
  if (!Number.isInteger(status) || status < 200 || status > 299) return null;
  if (method === 'GET' && READ_ROUTES.has(route ?? null)) return 'read';
  if (method === 'POST' && route === 'commands' && commandType === 'message.posted') return 'post';
  return 'connect';
}

export function createHttpConnectFunnel({ db, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS connect_funnel_http_salt (id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connect_funnel_http (
  key TEXT PRIMARY KEY, connected_at INTEGER NOT NULL,
  first_read_at INTEGER, first_post_at INTEGER, round_trip_at INTEGER)`);
  db.prepare('INSERT OR IGNORE INTO connect_funnel_http_salt (id, salt) VALUES (1, ?)').run(randomBytes(32).toString('hex'));
  const salt = db.prepare('SELECT salt FROM connect_funnel_http_salt WHERE id = 1').get().salt;
  const keyOf = token => createHash('sha256').update(salt).update('\0').update(token).digest('hex').slice(0, 32);
  const connect = db.prepare('INSERT OR IGNORE INTO connect_funnel_http (key, connected_at) VALUES (?, ?)');
  const read = db.prepare('UPDATE connect_funnel_http SET first_read_at = COALESCE(first_read_at, ?), round_trip_at = CASE WHEN round_trip_at IS NULL AND first_post_at IS NOT NULL THEN ? ELSE round_trip_at END WHERE key = ?');
  const post = db.prepare('UPDATE connect_funnel_http SET first_post_at = COALESCE(first_post_at, ?) WHERE key = ?');

  // observeHttp({ authorization, method, route, status, commandType }):
  // call once per completed room-route request, after its status is known.
  function observeHttp(event) {
    try {
      if (!event || !isAgentBearer(event.authorization)) return;
      const kind = classifyHttpFunnelEvent(event);
      if (!kind) return;
      const key = keyOf(bearerToken(event.authorization));
      const at = now();
      connect.run(key, at);
      if (kind === 'post') post.run(at, key);
      else if (kind === 'read') read.run(at, at, key);
    } catch { /* metrics never break a request */ }
  }

  function summary() {
    const rows = db.prepare('SELECT connected_at c, first_read_at r, round_trip_at t FROM connect_funnel_http').all();
    const step = column => {
      const ms = rows.filter(row => row[column] != null).map(row => row[column] - row.c).sort((a, b) => a - b);
      const mid = ms.length >> 1;
      return {
        reached: ms.length,
        completionRate: rows.length ? Math.round(ms.length / rows.length * 1000) / 1000 : null,
        medianMs: ms.length ? (ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2)) : null,
      };
    };
    return { connections: rows.length, firstAuthenticatedRead: step('r'), firstPostRoundTrip: step('t') };
  }

  return { observeHttp, summary };
}

// Flag gate for the wiring site: returns null (construct nothing, create no
// tables) unless ROOM_CONNECT_FUNNEL_HTTP === '1'.
export function httpConnectFunnelIfEnabled({ env = process.env, db, now } = {}) {
  if (!httpConnectFunnelEnabled(env) || !db) return null;
  return createHttpConnectFunnel({ db, now });
}
