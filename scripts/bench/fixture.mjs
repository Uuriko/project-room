// Deterministic room fixture for the room-scale benchmark, shaped like the
// busiest real room (muse-room): 60 members, ~870-character messages with
// unique text, about 5% of them thread replies. Authors rotate so the room
// flood guard (30 burst, 0.5/s refill per member) never trips, and the clock
// is simulated, so the same tree always builds the same room.
//
//   node scripts/bench/fixture.mjs --root <tree> --size 4000 --out <dir>
//
// --bodies-at-rest stores message bodies outside the projection (the
// ROOM_BODIES_AT_REST mode), which changes write and read costs a lot.
// Writes <dir>/room.sqlite plus <dir>/meta.json (access keys and clock). The
// tree's own modules build it, so base and head each get a room made by
// their own code.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOM_ID = "commons";
export const MEMBERS = 59; // plus the owner
const AUTHORS = 24;
const START = Date.parse("2026-10-01T00:00:00Z");
const STEP_MS = 15000;
const WORDS = ("verified byte check projection sequence head checksum matches expected value receipt room event cursor snapshot "
  + "stream fixed landed confirmed hash pinned build green claim review deploy rollback lease merge slot queue agent owner "
  + "thread reply channel draft migration index cache replay archive budget token latency budget window").split(" ");

export function rng(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function messageBody(random, index) {
  const target = 600 + Math.floor(random() * 540); // ~870 on average
  let text = `#${index} `;
  while (text.length < target) text += WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.08 ? ". " : " ");
  return text;
}

export async function loadTree(root) {
  const at = path => import(pathToFileURL(join(root, path)).href);
  const [{ RoomStore }, { initialRoom }, { EVENT_TYPES }] = await Promise.all([
    at("server/store.mjs"), at("server/bootstrap.mjs"), at("src/events.js")]);
  return { RoomStore, initialRoom, T: EVENT_TYPES, at };
}

export async function buildFixture({ root, size, out, seed = 20261018, bodiesAtRest = false }) {
  const { RoomStore, initialRoom, T } = await loadTree(root);
  mkdirSync(out, { recursive: true });
  let clock = START;
  const store = new RoomStore(join(out, "room.sqlite"), { now: () => clock, bodiesAtRest });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey(ROOM_ID, "owner");
  const keys = [owner];
  for (let i = 0; i < MEMBERS; i++) {
    store.command(owner, ROOM_ID, { id: `seed-member-${i}`, type: T.MEMBER_ADDED, data: { memberId: `agent${i}`, displayName: `Agent ${i}`, kind: i % 4 ? "agent" : "human", permissions: [] } });
    if (keys.length < AUTHORS) keys.push(store.issueAccessKey(ROOM_ID, `agent${i}`));
  }
  const random = rng(seed), roots = [];
  let failed = 0, lastError = null;
  for (let n = 1; n <= size; n++) {
    clock += STEP_MS;
    const reply = roots.length > 10 && random() < 0.05;
    const data = { messageId: `m${n}`, body: messageBody(random, n), ...(reply ? { replyToId: roots[Math.floor(random() * roots.length)] } : {}) };
    try {
      store.command(keys[n % keys.length], ROOM_ID, { id: `seed-${n}`, type: T.MESSAGE_POSTED, data });
      if (!reply) roots.push(data.messageId);
    } catch (error) { failed++; lastError = `${error.code ?? ""} ${error.message}`.trim(); }
  }
  const sequence = store.room(ROOM_ID).sequence;
  store.close();
  const meta = { roomId: ROOM_ID, size, seed, bodiesAtRest, sequence, clock, keys, failed, lastError, builtAt: new Date().toISOString() };
  writeFileSync(join(out, "meta.json"), JSON.stringify(meta, null, 1));
  return meta;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const meta = await buildFixture({ root: resolve(arg("root") ?? "."), size: Number(arg("size") ?? 1000), out: resolve(arg("out") ?? "bench-fixture"), bodiesAtRest: process.argv.includes("--bodies-at-rest") });
  process.stdout.write(JSON.stringify({ sequence: meta.sequence, failed: meta.failed, lastError: meta.lastError }) + "\n");
}
