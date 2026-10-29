#!/usr/bin/env node
// Projection-rebuild benchmark (S-09): what does rebuilding a room's
// projection from its event log cost at 1k / 4k / 16k events — the figure
// the deletion audit could not state — with the retained checkpoint the
// write path now keeps (checkpoint-on-write, every ~500 events) and
// without it (the fold from event 1 that was every ordinary room's only
// rebuild path before S-09).
//
//   node scripts/bench/rebuild.mjs [--sizes 1000,4000,16000] [--runs 3] [--out rebuild.json]
//
// The fixture is fixture.mjs's deterministic room shape (60 members,
// ~870-character unique messages, ~5% thread replies, same seed), seeded
// through store.initialize() — one replay of the generated log — instead
// of 16k individual commands, which price the write path, not the rebuild,
// and take tens of minutes at 16k. Seeding through initialize() also means
// a tree with checkpoint-on-write finishes seeding with a checkpoint at
// the head, exactly as its write path would leave it; the from-event-1
// figure is then measured on the same room after deleting that row.
// Each rebuild is timed in this process with the store already open;
// medians over --runs rebuilds. Absolute milliseconds are this machine's
// (see the env line of the JSON output); only same-machine comparisons
// are meaningful, per docs/BENCH.md.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTree, messageBody, rng, ROOM_ID, MEMBERS } from "./fixture.mjs";
import { median } from "./stats.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(arg("root", "."));
const sizes = arg("sizes", "1000,4000,16000").split(",").map(Number).filter(n => n > 0);
const runs = Number(arg("runs", 3));
const out = arg("out");
const START = Date.parse("2026-10-01T00:00:00Z");
const STEP_MS = 15000;
const AUTHORS = 24;

const { RoomStore, initialRoom, T } = await loadTree(root);
const { event } = await import(pathToFileURL(join(root, "src/events.js")).href);
const results = {};

for (const size of sizes) {
  const dir = mkdtempSync(join(tmpdir(), "room-rebuild-bench-"));
  try {
    // Deterministic log with fixture.mjs's shape and seed.
    const events = [...initialRoom(ROOM_ID)];
    const authors = ["owner"];
    for (let i = 0; i < MEMBERS; i++) {
      const memberId = `agent${i}`;
      if (authors.length < AUTHORS) authors.push(memberId);
      events.push(event({ type: T.MEMBER_ADDED, roomId: ROOM_ID, actorId: "owner",
        id: `seed-member-${i}`, idempotencyKey: `seed-member-${i}`,
        at: new Date(START + events.length * STEP_MS).toISOString(),
        data: { memberId, displayName: `Agent ${i}`, kind: i % 4 ? "agent" : "human", permissions: [] } }));
    }
    const random = rng(20261018), roots = [];
    for (let n = 1; n <= size; n++) {
      const reply = roots.length > 10 && random() < 0.05;
      const data = { messageId: `m${n}`, body: messageBody(random, n),
        ...(reply ? { replyToId: roots[Math.floor(random() * roots.length)] } : {}) };
      events.push(event({ type: T.MESSAGE_POSTED, roomId: ROOM_ID, actorId: authors[n % authors.length],
        id: `seed-${n}`, idempotencyKey: `seed-${n}`,
        at: new Date(START + events.length * STEP_MS).toISOString(), data }));
      if (!reply) roots.push(data.messageId);
    }

    const store = new RoomStore(join(dir, "room.sqlite"), { now: () => START });
    const seedStart = performance.now();
    store.initialize(events);
    const seedMs = Math.round(performance.now() - seedStart);
    const head = store.headSequence(ROOM_ID);
    const checkpoint = store.db.prepare("SELECT sequence FROM projection_checkpoints WHERE room_id=?").get(ROOM_ID);
    const projectionKB = Math.round(store.db.prepare("SELECT length(projection) AS b FROM rooms WHERE id=?").get(ROOM_ID).b / 1024);
    const time = fn => { const t = performance.now(); const value = fn(); return { ms: performance.now() - t, value }; };
    const medianRebuild = () => {
      const samples = [];
      let sequence = null;
      for (let i = 0; i < runs; i++) {
        globalThis.gc?.();
        const { ms, value } = time(() => store.rebuildProjection(ROOM_ID));
        sequence = value.sequence;
        samples.push(ms);
      }
      return { medianMs: Math.round(median(samples)), samplesMs: samples.map(s => Math.round(s)), sequence };
    };
    const withCheckpoint = medianRebuild();
    store.db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(ROOM_ID);
    const fromEvent1 = medianRebuild();
    store.close();
    results[size] = {
      events: head, seedMs, projectionKB,
      checkpointSequence: checkpoint?.sequence ?? null,
      checkpointLag: head - (checkpoint?.sequence ?? 0),
      rebuildWithCheckpointMs: withCheckpoint.medianMs, rebuildWithCheckpointSamplesMs: withCheckpoint.samplesMs,
      rebuildFromEvent1Ms: fromEvent1.medianMs, rebuildFromEvent1SamplesMs: fromEvent1.samplesMs,
      rebuiltSequence: fromEvent1.sequence
    };
    process.stderr.write(`[rebuild-bench] size ${size}: head ${head}, checkpoint ${checkpoint?.sequence ?? "none"}, with ${withCheckpoint.medianMs} ms, from event 1 ${fromEvent1.medianMs} ms\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const report = { env: { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, runs, sizes, date: new Date().toISOString(), note: "local-machine figures; compare ratios on the same machine only" }, sizes: results };
const lines = ["Projection rebuild (median ms, this machine)", "| events | projection | checkpoint (lag) | rebuild with checkpoint | rebuild from event 1 |", "|---|---|---|---|---|"];
for (const size of sizes) {
  const r = results[size];
  lines.push(`| ${r.events} | ${r.projectionKB} KB | ${r.checkpointSequence ?? "none"} (${r.checkpointLag}) | ${r.rebuildWithCheckpointMs} ms | ${r.rebuildFromEvent1Ms} ms |`);
}
process.stdout.write(lines.join("\n") + "\n");
process.stdout.write(JSON.stringify(report) + "\n");
if (out) writeFileSync(resolve(out), JSON.stringify(report, null, 1));
