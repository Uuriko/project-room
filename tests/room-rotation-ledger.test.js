// Rotation carry-over ledger (2026-09-27, RC-2026-09-27-2726).
//
// After the #266 -> #1160 board rotation, the new board's second comment is
// the [room-watch][rotation-handoff] ledger: the authoritative record of
// pre-existing claims, keyed by task-id. Open claims are NOT re-posted as
// [lane][claim] comments, so without ledger support the carried claims are
// invisible to the enforcer (RC-2026-09-27-005 was missing from state).
// A later "Carry-over ledger amendment" corrects a stale snapshot entry.
//
// Regression tests against scripts/room's REAL parser+reducer via the
// _parse/_state test verbs (no network). Each test FAILS on the pre-fix
// script, where the ledger and the amendment both parsed as prose.
//
// Env: ROOM_SCRIPT overrides the script under test (default: scripts/room).
// Pre-fix check: git show HEAD:scripts/room > .tmp/room-prefix
//                ROOM_SCRIPT=.tmp/room-prefix node --test tests/room-rotation-ledger.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = process.env.ROOM_SCRIPT
  ? resolve(checkout, process.env.ROOM_SCRIPT)
  : join(checkout, "scripts/room");

// Verbatim bodies of Uuriko/project-room#1160 comments 5859840718
// (rotation-handoff ledger) and 5859845108 (carry-over amendment).
const LEDGER_AT = "2026-09-27T21:08:17Z";
const LEDGER_BODY = `[room-watch][rotation-handoff]
old issue:    #266
new issue:    #1160
watermark:    5859826064
open claims:  RC-2026-09-27-2720 lane=jill state=submitted expires=2026-09-28T03:57:58Z (claimed 2026-09-27T19:57:58Z, lease=8h; files: server/http.mjs,server/store.mjs,server/board-v2-durable.mjs,server/board-v2-sqlite.mjs,server/writer-fence.mjs,scripts/runtime-package.mjs,docs/openapi.yaml,docs/ROUTE-AUTH-TABLE.md; reason: Worker B task, wire board-v2 durable registry into HTTP)
open claims:  RC-2026-09-27-005 lane=instinct state=working expires=2026-09-28T02:04:39Z (originally claimed 2026-09-27T08:13:24Z lease=6h; strike-one 14:33:49Z; strike-two 20:02:12Z; lane renewed lease=6h at 2026-09-27T20:04:39Z with state=working \u2014 renewal supersedes strike-two; files: server/referral-invites.mjs,tests/referral-invites.test.js; reason: referral redeem admits past room active-member cap; die-vs-defer decision framed to release owner, awaiting pick)
unclaimed lanes: quill-s2, grokbot, codex, jillianai
missing receipts: none (all done claims in the recent window carry pr/sha/receipt evidence)`;

const AMEND_AT = "2026-09-27T21:08:55Z";
const AMEND_BODY = `[jill] Carry-over ledger amendment (amends the [room-watch][rotation-handoff] comment posted as 5859840718).

RC-2026-09-27-2720 (jill, board-v2 durable registry wiring) was COMPLETED on #266 at 2026-09-27T21:08:18Z \u2014 comment 5859840872 with a full room-done block (PR #1158, sha 6a0fa572; 11/11 board-v2 HTTP tests, 58/58 board-v2 suites, full hosted CI green on exact head c4822f9c). This landed after the ledger snapshot, so the ledger's open-claims list is stale on this one item: 2720 is closed and is NOT carried.

Remaining open carried claim: RC-2026-09-27-005 (instinct, referral redeem-vs-cap decision, expires 2026-09-28T02:04:39Z).`;

const HEADER_BODY = `# Claims board (continued from #266)

Fresh claims board after the #266 rotation.`;

const comment = (id, at, body) => ({ id, created_at: at, updated_at: at, body });
const headerComment = () => comment(5859839000, "2026-09-27T21:07:37Z", HEADER_BODY);
const ledgerComment = (body = LEDGER_BODY) => comment(5859840718, LEDGER_AT, body);
const amendComment = (body = AMEND_BODY, id = 5859845108) =>
  comment(id, AMEND_AT, body);

function parse(comments) {
  const parsed = spawnSync(room, ["_parse"], {
    input: JSON.stringify(comments), encoding: "utf8", timeout: 30000,
  });
  assert.equal(parsed.status, 0, `_parse failed: ${parsed.stderr}`);
  return JSON.parse(parsed.stdout);
}

function reduce(comments, nowIso) {
  const events = parse(comments);
  const st = spawnSync(room, ["_state", "--now", nowIso], {
    input: JSON.stringify(events), encoding: "utf8", timeout: 30000,
  });
  assert.equal(st.status, 0, `_state failed: ${st.stderr}`);
  return JSON.parse(st.stdout);
}

const task = (st, tid) => st.tasks.find(t => t.task_id === tid);
const eventFor = (events, id) => events.find(e => e.id === id);

test("ledger parses as rotation-handoff and amendment as rotation-amendment", () => {
  const events = parse([headerComment(), ledgerComment(), amendComment()]);
  const lh = eventFor(events, 5859840718);
  assert.equal(lh.kind, "rotation-handoff");
  assert.equal(lh.handoff.ok, true);
  assert.deepEqual(
    lh.handoff.claims.map(c => c.task_id).sort(),
    ["RC-2026-09-27-005", "RC-2026-09-27-2720"]);
  const am = eventFor(events, 5859845108);
  assert.equal(am.kind, "rotation-amendment");
  assert.equal(am.ok, true);
  assert.equal(am.task_id, "RC-2026-09-27-2720");
});

test("ledger restores RC-005 with its ORIGINAL expiry, not the ledger post date", () => {
  const st = reduce(
    [headerComment(), ledgerComment(), amendComment()],
    "2026-09-27T21:45:00Z");
  const rc5 = task(st, "RC-2026-09-27-005");
  assert.ok(rc5, "RC-2026-09-27-005 must be restored from the ledger");
  assert.equal(rc5.lane, "instinct");
  assert.equal(rc5.state, "working");
  assert.equal(rc5.carried, true);
  // The contract: carried claims keep their original expiries; the ledger
  // post date (21:08:17Z) must never become the lease base.
  assert.equal(rc5.lease_expires_at, "2026-09-28T02:04:39Z");
  assert.deepEqual(
    rc5.files,
    ["server/referral-invites.mjs", "tests/referral-invites.test.js"]);
  assert.equal(st.rotation.old_issue, "266");
  assert.equal(st.rotation.new_issue, "1160");
});

test("amendment closes the stale carried entry with its old-board evidence", () => {
  const st = reduce(
    [headerComment(), ledgerComment(), amendComment()],
    "2026-09-27T21:45:00Z");
  const rc2720 = task(st, "RC-2026-09-27-2720");
  assert.ok(rc2720, "RC-2026-09-27-2720 must be registered from the ledger");
  assert.equal(rc2720.state, "completed");
  assert.equal(rc2720.receipts[0].pr, "1158");
  assert.equal(rc2720.receipts[0].merged, "6a0fa572");
});

test("a later fenced re-claim of a carried task-id is refused; the ledger stands", () => {
  const reclaim = comment(5859846000, "2026-09-27T22:00:00Z",
    `[instinct][claim]\n\n\`\`\`room-claim\ntask-id: RC-2026-09-27-005\nlane: instinct\nfiles: server/referral-invites.mjs\nlease: lease=6h\nstate: working\nreason: re-claim after rotation\n\`\`\``);
  const st = reduce(
    [headerComment(), ledgerComment(), amendComment(), reclaim],
    "2026-09-27T22:30:00Z");
  const rc5 = task(st, "RC-2026-09-27-005");
  assert.equal(rc5.lease_expires_at, "2026-09-28T02:04:39Z",
    "ledger expiry must not be clobbered by a re-posted claim");
  assert.ok(
    st.refused.some(r => r.task_id === "RC-2026-09-27-005"),
    "the duplicate re-claim must be refused loudly");
});

test("malformed ledger (missing watermark) registers nothing and logs loudly", () => {
  const bad = LEDGER_BODY.split("\n").filter(l => !l.startsWith("watermark:")).join("\n");
  const events = parse([headerComment(), ledgerComment(bad)]);
  const lh = eventFor(events, 5859840718);
  assert.equal(lh.kind, "rotation-handoff");
  assert.equal(lh.handoff.ok, false);
  const st = reduce([headerComment(), ledgerComment(bad)], "2026-09-27T21:45:00Z");
  assert.equal(task(st, "RC-2026-09-27-005"), undefined,
    "no carried claims may register from a malformed ledger");
  assert.ok(
    st.log.some(e => e.kind === "rotation-handoff" && e.ok === false),
    "the malformed ledger must be logged, never silent");
});

test("amendment referencing the wrong ledger comment id is ignored", () => {
  const wrong = AMEND_BODY.replace("posted as 5859840718", "posted as 12345");
  const st = reduce(
    [headerComment(), ledgerComment(), amendComment(wrong)],
    "2026-09-27T21:45:00Z");
  const rc2720 = task(st, "RC-2026-09-27-2720");
  assert.equal(rc2720.state, "submitted",
    "an amendment that does not reference the parsed handoff must change nothing");
  assert.ok(
    st.log.some(e => e.kind === "rotation-amendment" && e.ok === false),
    "the ignored amendment must be logged, never silent");
});
