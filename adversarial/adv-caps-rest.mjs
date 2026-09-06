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

// S2: member ceiling - 100 members fit, 101st rejects.
{
  const { store, directory } = fresh();
  const owner = store.issueAccessKey("commons", "owner");
  let added = 0;
  for (let i = 1; i <= 99; i++) { send(store, owner, T.MEMBER_ADDED, { memberId: `m-${i}`, displayName: `M${i}`, kind: "human", permissions: [] }); added++; }
  check("100 members present (owner + 99)", Object.keys(store.room("commons").state.members).length === 100);
  let rejected = null;
  try { send(store, owner, T.MEMBER_ADDED, { memberId: "m-101", displayName: "X", kind: "human", permissions: [] }); } catch (e) { rejected = e; }
  check("101st member rejected 409 pilot_limit", rejected?.status === 409 && rejected?.code === "pilot_limit", JSON.stringify(rejected?.code));
  check("no partial member write", Object.keys(store.room("commons").state.members).length === 100 && !store.room("commons").state.members["m-101"]);
  store.close(); rmSync(directory, { recursive: true, force: true });
}
// S3: work-item ceiling - 500 fit, 501st rejects.
{
  const { store, directory } = fresh();
  const owner = store.issueAccessKey("commons", "owner");
  for (let i = 1; i <= 500; i++) send(store, owner, T.WORK_PROPOSED, { workItemId: `w-${i}`, title: `t${i}`, definitionOfDone: "d", accountableMemberId: "owner", verifierMemberId: "owner", mode: "read" });
  check("500 work items present", Object.keys(store.room("commons").state.workItems).length === 500);
  let rejected = null;
  try { send(store, owner, T.WORK_PROPOSED, { workItemId: "w-501", title: "x", definitionOfDone: "d", accountableMemberId: "owner", verifierMemberId: "owner", mode: "read" }); } catch (e) { rejected = e; }
  check("501st work item rejected 409 pilot_limit", rejected?.status === 409 && rejected?.code === "pilot_limit", JSON.stringify(rejected?.code));
  check("no partial work write", Object.keys(store.room("commons").state.workItems).length === 500);
  store.close(); rmSync(directory, { recursive: true, force: true });
}
// S4: credential ceiling - 5,000 rows, the next insert rejects, nothing half-written.
{
  const { store, directory } = fresh();
  const owner = store.issueAccessKey("commons", "owner"); // row 1
  let issued = 1;
  let rejected = null;
  try { while (true) { store.issueAccessKey("commons", "owner"); issued++; } } catch (e) { rejected = e; }
  check("credential insert stops at 409 pilot_limit", rejected?.status === 409 && rejected?.code === "pilot_limit", JSON.stringify(rejected?.code));
  const rows = store.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id='commons'").get().n;
  check("exactly 5,000 credential rows, no overflow", rows === 5000, `rows=${rows}`);
  check("issueAccessKey failure left no dangling row", issued === 5000, `issued=${issued}`);
  store.close(); rmSync(directory, { recursive: true, force: true });
}
// S5: command-size guard - the 16KB command cap fires before the 4MB projection cap.
{
  const { store, directory } = fresh();
  const owner = store.issueAccessKey("commons", "owner");
  const before = store.room("commons").sequence;
  let rejected = null;
  try { send(store, owner, T.MESSAGE_POSTED, { messageId: "huge", body: "x".repeat(20 * 1024) }); } catch (e) { rejected = e; }
  check("20KB command rejected 413 too_large", rejected?.status === 413 && rejected?.code === "too_large", JSON.stringify(rejected?.code));
  check("no partial write on oversized command", store.room("commons").sequence === before);
  const okMsg = send(store, owner, T.MESSAGE_POSTED, { messageId: "fits", body: "x".repeat(4000) });
  check("4000-char command accepted (field cap 4096)", okMsg.sequence === before + 1);
  store.close(); rmSync(directory, { recursive: true, force: true });
}
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
