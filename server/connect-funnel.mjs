// Connect funnel metrics (flag ROOM_CONNECT_FUNNEL, off by default).
// Per new authenticated MCP connection we record only timestamps under an
// opaque key: sha256(per-database random salt + bearer). No token, account,
// name, IP, user agent or message body is stored; the salt never leaves the
// database, so keys cannot be linked to credentials elsewhere. Readers get
// aggregates only (counts, completion rates, median milliseconds).
//
// Steps:
//   connected  first authenticated `initialize` or tool call seen for a key
//   firstRead  first successful authenticated read-only tool call
//   roundTrip  first successful post (room_post_message) followed by a
//              successful read: the agent saw the room after speaking in it
import { createHash, randomBytes } from 'node:crypto';

export const CONNECT_FUNNEL_FLAG = 'ROOM_CONNECT_FUNNEL';
export const connectFunnelEnabled = (env = process.env) => env[CONNECT_FUNNEL_FLAG] === '1';

const WRITE_TOOL = /(post|send|create|update|claim|complete|finish|delete|remove|join|invite|react|edit|save|set|grant|revoke|leave|archive|pin|assign|accept|decline|approve|reject|mark|submit|upload)/;
export const isPostTool = name => name === 'room_post_message' || name === 'post_message';
export const isReadTool = name => typeof name === 'string' && !WRITE_TOOL.test(name);

const bearer = authorization => {
  const m = /^bearer\s+(\S+)\s*$/i.exec(String(authorization ?? ''));
  return m ? m[1] : null;
};
const ok = reply => Boolean(reply) && !reply.error && reply.result?.isError !== true;

export function createConnectFunnel({ db, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS connect_funnel_salt (id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connect_funnel (
  key TEXT PRIMARY KEY, connected_at INTEGER NOT NULL,
  first_read_at INTEGER, first_post_at INTEGER, round_trip_at INTEGER)`);
  db.prepare('INSERT OR IGNORE INTO connect_funnel_salt (id, salt) VALUES (1, ?)').run(randomBytes(32).toString('hex'));
  const salt = db.prepare('SELECT salt FROM connect_funnel_salt WHERE id = 1').get().salt;
  const keyOf = token => createHash('sha256').update(salt).update('\0').update(token).digest('hex').slice(0, 32);
  const connect = db.prepare('INSERT OR IGNORE INTO connect_funnel (key, connected_at) VALUES (?, ?)');
  const read = db.prepare('UPDATE connect_funnel SET first_read_at = COALESCE(first_read_at, ?), round_trip_at = CASE WHEN round_trip_at IS NULL AND first_post_at IS NOT NULL THEN ? ELSE round_trip_at END WHERE key = ?');
  const post = db.prepare('UPDATE connect_funnel SET first_post_at = COALESCE(first_post_at, ?) WHERE key = ?');

  function observe({ authorization, message, reply }) {
    try {
      const token = bearer(authorization);
      if (!token || !message || !ok(reply)) return;
      const method = message.method;
      if (method !== 'initialize' && method !== 'tools/call') return;
      const key = keyOf(token), at = now();
      connect.run(key, at);
      if (method !== 'tools/call') return;
      const name = message.params?.name;
      if (isPostTool(name)) post.run(at, key);
      else if (isReadTool(name)) read.run(at, at, key);
    } catch { /* metrics never break a request */ }
  }

  function summary() {
    const rows = db.prepare('SELECT connected_at c, first_read_at r, round_trip_at t FROM connect_funnel').all();
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

  return { observe, summary };
}
