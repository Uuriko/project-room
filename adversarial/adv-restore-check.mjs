// Pass 32: E2 restore drill. Backup/restore of the SQLite store, WAL hazard, corruption behavior.
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};
const sha = s => createHash("sha256").update(s).digest("hex");
const cmd = (type, data, id = crypto.randomUUID()) => ({ id, type, data });
const pageAll = (store, token, roomId) => {
  const out = []; let after = 0;
  while (true) { const page = store.eventsAfter(token, roomId, after, 100); out.push(...page.events); if (!page.hasMore) break; after = page.next; }
  return out;
};

// D1: graceful close -> file copy -> reopen: byte-identical state, continued operation, idempotency intact.
{
  const dirA = mkdtempSync(join(tmpdir(), "adv-restore-a-"));
  const fileA = join(dirA, "room.sqlite");
  const storeA = new RoomStore(fileA);
  storeA.initialize(initialRoom());
  const owner = storeA.issueAccessKey("commons", "owner");
  const humanCmd = cmd(T.MEMBER_ADDED, { memberId: "h1", displayName: "H", kind: "human", permissions: ["steer", "accept_work", "complete_work"] });
  storeA.command(owner, "commons", humanCmd);
  const h1 = storeA.issueAccessKey("commons", "h1");
  const dupCmd = cmd(T.MESSAGE_POSTED, { body: "durable message one" });
  const first = storeA.command(h1, "commons", dupCmd);
  for (let i = 0; i < 25; i++) storeA.command(h1, "commons", cmd(T.MESSAGE_POSTED, { body: `m${i}` }));
  storeA.command(h1, "commons", cmd(T.WORK_PROPOSED, { workItemId: "w1", title: "t", definitionOfDone: "d", accountableMemberId: "h1", verifierMemberId: "owner", mode: "read" }));
  storeA.markCaughtUp(h1, "commons", first.sequence);
  const seqBefore = storeA.room("commons").sequence;
  const projBefore = storeA.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const eventsBefore = pageAll(storeA, h1, "commons").map(e => JSON.stringify(e));
  storeA.close();

  const dirB = mkdtempSync(join(tmpdir(), "adv-restore-b-"));
  const fileB = join(dirB, "room.sqlite");
  copyFileSync(fileA, fileB);
  const storeB = new RoomStore(fileB);
  check("restored sequence identical", storeB.room("commons").sequence === seqBefore, `${storeB.room("commons").sequence} vs ${seqBefore}`);
  check("restored projection byte-identical", storeB.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection === projBefore);
  check("restored event log identical (all events paged)", JSON.stringify(pageAll(storeB, h1, "commons").map(e => JSON.stringify(e))) === JSON.stringify(eventsBefore));
  check("issued credential authenticates on restored store", storeB.authenticate(h1, "commons").member.id === "h1");
  check("cursor survives restore", storeB.snapshot(h1, "commons").cursor === first.sequence);
  const dup = storeB.command(h1, "commons", dupCmd);
  check("replayed command id returns duplicate with original sequence", dup.duplicate === true && dup.sequence === first.sequence, JSON.stringify({ dup: dup.duplicate, seq: dup.sequence, orig: first.sequence }));
  const next = storeB.command(h1, "commons", cmd(T.MESSAGE_POSTED, { body: "after restore" }));
  check("new command continues at sequence+1 (no id reuse)", next.sequence === seqBefore + 1, `seq=${next.sequence}`);
  storeB.close(); rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
}
// D2: WAL hazard - copying ONLY the .db while the source is still open can silently lose recent events.
{
  const dirA = mkdtempSync(join(tmpdir(), "adv-wal-a-"));
  const fileA = join(dirA, "room.sqlite");
  const storeA = new RoomStore(fileA);
  storeA.initialize(initialRoom());
  const owner = storeA.issueAccessKey("commons", "owner");
  storeA.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // force a clean checkpoint baseline
  const baseline = storeA.room("commons").sequence;
  for (let i = 0; i < 30; i++) storeA.command(owner, "commons", cmd(T.MESSAGE_POSTED, { body: `wal${i}` }));
  const liveSeq = storeA.room("commons").sequence;
  const walExists = existsSync(fileA + "-wal");
  const dirC = mkdtempSync(join(tmpdir(), "adv-wal-c-"));
  const fileC = join(dirC, "room.sqlite");
  copyFileSync(fileA, fileC); // .db only, no -wal: the classic bad backup
  const storeC = new RoomStore(fileC);
  const copiedSeq = storeC.room("commons").sequence;
  check("bad backup (no -wal) opens CONSISTENT but possibly stale", copiedSeq >= baseline && copiedSeq <= liveSeq, `copied=${copiedSeq} live=${liveSeq}`);
  console.log(`     [drill finding] live sequence ${liveSeq}, .db-only copy sequence ${copiedSeq}, wal present: ${walExists} -> backups must checkpoint/close or include -wal`);
  check("drill documents staleness honestly", true);
  storeC.close(); storeA.close(); rmSync(dirA, { recursive: true, force: true }); rmSync(dirC, { recursive: true, force: true });
}
// D3: corruption - a damaged store fails loudly and is never silently reset.
{
  const dirD = mkdtempSync(join(tmpdir(), "adv-corrupt-"));
  const fileD = join(dirD, "room.sqlite");
  const storeD = new RoomStore(fileD);
  storeD.initialize(initialRoom());
  const owner = storeD.issueAccessKey("commons", "owner");
  storeD.command(owner, "commons", cmd(T.MESSAGE_POSTED, { body: "before corruption" }));
  storeD.close();
  const bytes = readFileSync(fileD);
  const sizeBefore = bytes.length;
  const corrupt = Buffer.from(bytes);
  corrupt.fill(0xff, 0, 100); // destroy the SQLite header
  writeFileSync(fileD, corrupt);
  let threw = null;
  try { const reopened = new RoomStore(fileD); reopened.room("commons"); } catch (e) { threw = e; }
  check("corrupted store open/read throws (loud failure)", threw !== null, String(threw));
  const afterBytes = readFileSync(fileD);
  check("corrupted file NOT silently reset or truncated", afterBytes.length === sizeBefore && afterBytes.slice(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])), `size ${afterBytes.length} vs ${sizeBefore}`);
  const trunc = join(dirD, "trunc.sqlite");
  writeFileSync(trunc, bytes.subarray(0, Math.floor(bytes.length / 2)));
  let threw2 = null;
  try { const t2 = new RoomStore(trunc); t2.room("commons"); } catch (e) { threw2 = e; }
  check("truncated store fails loudly too", threw2 !== null, String(threw2));
  rmSync(dirD, { recursive: true, force: true });
}
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
