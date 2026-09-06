// Pass 28: pilot-cap boundary tests. Exact on/off boundaries, no partial writes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};
const fresh = () => {
  const directory = mkdtempSync(join(tmpdir(), "adv-caps-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  return { store, directory };
};
const send = (store, key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });

// S1: event ceiling - 10,000th event lands, 10,001st rejects, no partial write.
{
  const t0 = Date.now();
  const { store, directory } = fresh();
  const owner = store.issueAccessKey("commons", "owner");
  const start = store.room("commons").sequence;
  while (store.room("commons").sequence < 9999) send(store, owner, T.MESSAGE_POSTED, { messageId: crypto.randomUUID(), body: "filler" });
  const one = send(store, owner, T.MESSAGE_POSTED, { messageId: "at-cap", body: "the 10,000th" });
  check("10,000th event accepted", one.sequence === 10000);
  let rejected = null;
  try { send(store, owner, T.MESSAGE_POSTED, { messageId: "over-cap", body: "10,001st" }); } catch (e) { rejected = e; }
  check("10,001st rejected 409 pilot_limit", rejected?.status === 409 && rejected?.code === "pilot_limit", JSON.stringify(rejected?.code));
  check("no partial write past the cap", store.room("commons").sequence === 10000);
  check("rejected message absent from projection", !store.room("commons").state.messages.some(m => m.id === "over-cap"));
  console.log(`     (seeded 10k events in ${Date.now() - t0}ms)`);
  store.close(); rmSync(directory, { recursive: true, force: true });
}
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
