// SIM benchmark for WAVE-300 F1 (shared SSE pump per room).
//
// Measures event-loop delay (perf_hooks.monitorEventLoopDelay) with N fake
// SSE streams over `--seconds` seconds, plus the number of store.eventsAfter
// calls. Run against the pre-F1 tree for the "before" number and the F1 tree
// for the "after" number:
//
//   node tests/bench-fanout-f1.mjs --label before --streams 100 --seconds 10
//
// The fake store returns a raw page per eventsAfter call (like the real
// store with { includeInvisible: true }) and does the same per-row
// JSON.parse the real store does; the projection carries 2000 messages so
// redactEventPage's per-call indexing costs what it costs in production.
// Only the SQLite query itself is faked. Label: SIM.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRoomServer } from '../server/http.mjs';

const rawArgs = process.argv.slice(2);
const args = {};
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) args[a.slice(2)] = rawArgs[++i];
  else args[a.slice(2)] = true;
}
const LABEL = args.label ?? 'unlabeled';
const STREAMS = Number(args.streams ?? 100);
const SECONDS = Number(args.seconds ?? 10);
const INTERVAL = Number(args.interval ?? 250); // default STREAM_INTERVAL_DEFAULT_MS
const PRELOAD = Number(args.preload ?? 5000);
const PROJECTION_MESSAGES = Number(args.projectionMessages ?? 2000);
// --atHead: open streams at the log head so pages are empty. This isolates
// the per-pump fetch+redact+projection work F1 shares (the per-stream
// stringify+write path is unchanged by F1 and identical in both runs).
// Default (after=0) runs full 100-row pages: maximum realistic mix.
const AT_HEAD = args.atHead === true || args.atHead === 'true';

const tok = name => (name + 'x'.repeat(43)).slice(0, 43);

function fakeStore() {
  const events = [];
  for (let i = 1; i <= PRELOAD; i++) {
    events.push({ sequence: i, body: JSON.stringify({ id: `evt-${i}`, type: 'message.posted', actorId: 'member-a', data: { body: `body-${i}-` + 'x'.repeat(180) } }) });
  }
  const store = {
    eventsAfterCalls: 0,
    authenticate(token) {
      return { member: { id: 'member-a' }, credentialHash: `h-${token}`, credentialScope: 'room', kind: 'identity', sessionBinding: null };
    },
    eventsAfter(token, roomId, after = 0, limit = 100) {
      this.eventsAfterCalls++;
      const rows = [];
      for (const r of events) {
        if (r.sequence <= after) continue;
        rows.push({ sequence: r.sequence, event: JSON.parse(r.body) });
        if (rows.length >= limit) break;
      }
      const sequence = events.length;
      const reachedEnd = rows.length < limit;
      const next = reachedEnd ? sequence : rows.at(-1).sequence;
      return { events: rows, next, hasMore: next < sequence };
    },
    room() {
      // Rebuilt per call, like the real projection decode the pump pays.
      const messages = [];
      for (let i = 1; i <= PROJECTION_MESSAGES; i++) {
        messages.push({ id: `msg-${i}`, body: `message ${i}`, createdAt: '2026-10-08T00:00:00.000Z', authorId: 'member-a' });
      }
      return { state: { messages, room: { ownerId: 'owner' } } };
    },
    roomAuthority() { return { ownerId: 'owner', sequence: events.length, members: {} }; },
    historyFloor() { return null; },
    bonds: { identityForMember() { return null; } },
  };
  return store;
}

const store = fakeStore();
// A huge queue cap + no client reads: socket writes buffer instead of
// tripping stream_lagging, so the loop measures server pump work rather
// than client drain speed. (Undrained, the 100 streams buffer ~80MB here.)
const server = createRoomServer({ store, streamInterval: INTERVAL, streamQueueCap: 256 * 1024 * 1024 });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// N streams over a preloaded log. --atHead opens them at the head (empty
// pages: isolates the shared fetch/redact/projection work); otherwise
// after=0 (full 100-row pages: maximum realistic mix). Clients do not read
// (see the queue-cap note above); the server buffers.
const readers = [];
const openAfter = AT_HEAD ? PRELOAD : 0;
for (let i = 0; i < STREAMS; i++) {
  const response = await fetch(`${origin}/api/rooms/room-a/stream?after=${openAfter}`, {
    headers: { Authorization: `Bearer ${tok(`bench-token-${i}`)}` },
  });
  if (response.status !== 200) throw new Error(`stream ${i} open failed: ${response.status}`);
  readers.push(response.body.getReader());
}

const histogram = monitorEventLoopDelay({ resolution: 1 });
histogram.enable();
const callsBefore = store.eventsAfterCalls;
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
await sleep(SECONDS * 1000);
histogram.disable();
const callsAfter = store.eventsAfterCalls;
const cpuAfter = process.cpuUsage(cpuBefore);
const wallMs = performance.now() - wallBefore;

const mean = histogram.mean / 1e6, p99 = histogram.percentile(99) / 1e6, max = histogram.max / 1e6;
// Event-loop work per wall second, from process.cpuUsage (the delay
// histogram's floor on this VM is ~1000ms/sec even idle, so it cannot
// discriminate; cpuUsage measures the pump's actual burn).
const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000;
const cpuMsPerSec = cpuMs / (wallMs / 1000);
console.log(JSON.stringify({
  label: `SIM ${LABEL}`,
  streams: STREAMS, seconds: SECONDS, pumpIntervalMs: INTERVAL, preloadEvents: PRELOAD, projectionMessages: PROJECTION_MESSAGES, atHead: AT_HEAD,
  eventsAfterCalls: callsAfter - callsBefore,
  cpu: {
    cpuMsPerSec: Number(cpuMsPerSec.toFixed(1)),
    cpuMsTotal: Number(cpuMs.toFixed(0)),
  },
  eventLoopDelay: {
    meanMs: Number(mean.toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    maxMs: Number(max.toFixed(2)),
    samples: histogram.count,
  },
}, null, 2));

for (const reader of readers) await reader.cancel().catch(() => {});
server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
process.exit(0);
