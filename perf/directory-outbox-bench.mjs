// The outbox tax (Stage 0): per-command write overhead with the
// directory outbox feed on vs off, on the same shaped room, same bench.
//
//   node perf/directory-outbox-bench.mjs
//
// Shaped room: 200 seeded messages (a mid-size active room's projection),
// then 200 further message.posted commands per arm. Each arm counts SQL
// statements by wrapping db.prepare for one counted pass, then times
// repeated passes and reports the median. In-memory stores are used so
// the number isolates CPU/statement cost from this machine's disk; the
// on-disk delta is one extra indexed INSERT per command inside a
// transaction that already writes events + commands + rooms rows.
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { maybeAppendRoomEventOutbox, outboxStats } from "../server/directory-outbox.mjs";

const SEED = 200;
const POSTS = 200;
const ROUNDS = 5;

function shapedStore(directoryOutbox) {
  // A steadily advancing clock keeps the room flood guard (burst limits
  // per wall-clock window) out of a bench that posts hundreds of
  // messages as fast as the CPU allows.
  let tick = 1_700_000_000_000;
  const store = new RoomStore(":memory:", { directoryOutbox, now: () => (tick += 3000) });
  store.initialize(initialRoom("bench"));
  const key = store.issueAccessKey("bench", "owner");
  for (let i = 0; i < SEED; i++) {
    store.command(key, "bench", { id: `seed-${i}`, type: "message.posted", data: { body: `seed message ${i} with some ordinary length to it`, messageId: `seed-${i}` } });
  }
  return { store, key };
}

function countedPass(directoryOutbox) {
  const { store, key } = shapedStore(directoryOutbox);
  let statements = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (...args) => { statements += 1; return prepare(...args); };
  const exec = store.db.exec.bind(store.db);
  store.db.exec = (...args) => { statements += 1; return exec(...args); };
  for (let i = 0; i < POSTS; i++) {
    store.command(key, "bench", { id: `bench-${i}`, type: "message.posted", data: { body: `bench message ${i}`, messageId: `bench-${i}` } });
  }
  store.db.prepare = prepare;
  store.db.exec = exec;
  const stats = outboxStats(store);
  store.db.close();
  return { statements, stats };
}

function timedPass(directoryOutbox) {
  const { store, key } = shapedStore(directoryOutbox);
  const started = performance.now();
  for (let i = 0; i < POSTS; i++) {
    store.command(key, "bench", { id: `bench-${i}`, type: "message.posted", data: { body: `bench message ${i}`, messageId: `bench-${i}` } });
  }
  const elapsed = performance.now() - started;
  store.db.close();
  return elapsed;
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const offCount = countedPass(false);
const onCount = countedPass(true);
// Interleave the arms round by round: on a contended machine, load drift
// between two blocks of rounds would otherwise masquerade as tax.
const offRounds = [];
const onRounds = [];
for (let round = 0; round < ROUNDS; round++) {
  offRounds.push(timedPass(false));
  onRounds.push(timedPass(true));
}
const offMs = median(offRounds);
const onMs = median(onRounds);

const rows = [
  ["arm", "statements / command", "ms / 200 commands (median)", "ms / command", "outbox entries"],
  ["outbox OFF", (offCount.statements / POSTS).toFixed(1), offMs.toFixed(1), (offMs / POSTS).toFixed(3), String(offCount.stats.total)],
  ["outbox ON", (onCount.statements / POSTS).toFixed(1), onMs.toFixed(1), (onMs / POSTS).toFixed(3), String(onCount.stats.total)]
];
console.log(`# Outbox tax — shaped room (${SEED} seeded messages), ${POSTS} message.posted commands per arm, median of ${ROUNDS} timed rounds\n`);
for (const row of rows) console.log(`| ${row.join(" | ")} |`);
const stmtDelta = onCount.statements / POSTS - offCount.statements / POSTS;
const msDelta = onMs / POSTS - offMs / POSTS;
const pct = offMs > 0 ? ((onMs - offMs) / offMs * 100).toFixed(1) : "n/a";
console.log(`\nTax: +${stmtDelta.toFixed(1)} statements/command, +${msDelta.toFixed(3)} ms/command (${pct}% per-command wall time on this in-memory bench).`);

// The whole-command wall time on a shared VM is too noisy to price a
// sub-0.1 ms addition (repeated runs of this bench swing both ways), so
// price the addition directly: payload build + insert, in one
// transaction, over the shaped room's real post-commit state.
{
  const { store } = shapedStore(false);
  const state = store.room("bench").state;
  const event = { id: "bench-event", type: "message.posted", actorId: "owner", at: new Date().toISOString(), data: { messageId: "bench-event" } };
  const N = 2000;
  const started = performance.now();
  store.transaction(() => {
    for (let i = 0; i < N; i++) {
      maybeAppendRoomEventOutbox(
        { directoryOutboxEnabled: true, db: store.db, now: () => Date.now() },
        { roomId: "bench", sequence: 10000 + i, event, state, projectionBytes: 123456 }
      );
    }
  });
  const perAppend = (performance.now() - started) / N;
  console.log(`Direct append cost (payload build + INSERT, in-transaction): ${perAppend.toFixed(4)} ms/entry over ${N} appends.`);
  store.db.close();
}
