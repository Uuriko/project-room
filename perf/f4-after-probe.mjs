// F4 A/B probe: full pump-tick read cost (eventsAfter + store.room, as in
// server/http.mjs stream()) under scratch-room write load.
//   BEFORE: emulates the old behavior — every outermost write txn dropped
//           the whole projection cache.
//   AFTER:  sequence-keyed cache; unrelated writes keep the entry warm.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const dir = mkdtempSync(join(tmpdir(), "f4-after-probe-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("muse"));
store.initialize(initialRoom("scratch"));
const museKey = store.issueAccessKey("muse", "owner");
const scratchKey = store.issueAccessKey("scratch", "owner");
const msg = i => ({ id: randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities: [`f4-${i}`] } });
for (let i = 0; i < 400; i++) store.command(museKey, "muse", msg(i));

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

async function runPhase(label, emulateOldClear) {
  const lat = [];
  let cursor = 0;
  const stopAt = Date.now() + 10000;
  let wi = 0;
  const writer = (async () => {
    while (Date.now() < stopAt) {
      for (let b = 0; b < 8; b++) store.command(scratchKey, "scratch", msg(wi++));
      if (emulateOldClear) store._projectionCache.clear(); // old blanket-drop behavior
      await new Promise(r => setImmediate(r));
    }
  })();
  const reader = (async () => {
    while (Date.now() < stopAt) {
      const t0 = performance.now();
      const page = store.eventsAfter(museKey, "muse", cursor, 100, null);
      cursor = page.next;
      store.room("muse"); // projectionMessages(roomId)
      lat.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 250));
    }
  })();
  await Promise.all([writer, reader]);
  console.log(`${label}: n=${lat.length} p50=${pct(lat, 50).toFixed(2)}ms p99=${pct(lat, 99).toFixed(2)}ms max=${Math.max(...lat).toFixed(2)}ms`);
}

console.log("=== F4 A/B: pump-tick read cost (eventsAfter + store.room) under scratch-room write load ===");
await runPhase("BEFORE (emulated blanket cache clear)", true);
await runPhase("AFTER  (sequence-keyed cache, targeted invalidation)", false);
store.close();
rmSync(dir, { recursive: true, force: true });
