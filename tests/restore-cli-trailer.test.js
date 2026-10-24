// Ruling 34 at the operator CLI: scripts/restore-room-backup.mjs refuses a
// trailer-absent export (QA case 1c) unless --legacy is passed, matching
// the HTTP operator doors.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { hasTrailer } from "../scripts/restore-room-backup.mjs";

const script = fileURLToPath(new URL("../scripts/restore-room-backup.mjs", import.meta.url));

function seeded(t) {
  const directory = mkdtempSync(join(tmpdir(), "restore-cli-trailer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "seed.sqlite"));
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "CLI agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "first" } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "second" } });
  const ndjson = exportNdjsonText(store.db);
  store.close();
  return { directory, ndjson };
}

function case1c(ndjson) {
  let m = false, tier = false;
  return ndjson.trim().split("\n").filter(line => {
    const r = JSON.parse(line);
    if (r.kind === "trailer") return false;
    if (r.table === "messages" && !m) { m = true; return false; }
    if (r.table === "agent_autonomy_tiers" && !tier) { tier = true; return false; }
    return true;
  }).join("\n") + "\n";
}

test("hasTrailer reads the last non-empty line", t => {
  const { ndjson } = seeded(t);
  assert.equal(hasTrailer(ndjson), true);
  assert.equal(hasTrailer(ndjson + "\n\n"), true);
  assert.equal(hasTrailer(case1c(ndjson)), false);
  assert.equal(hasTrailer(""), false);
});

test("the restore CLI refuses the case-1c torn export without --legacy and leaves no store", t => {
  const { directory, ndjson } = seeded(t);
  const file = join(directory, "torn.ndjson");
  writeFileSync(file, case1c(ndjson));
  const target = join(directory, "out", "room.sqlite");
  const run = spawnSync(process.execPath, [script, "--from", file, "--to", target], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no trailer/);
  assert.equal(existsSync(target), false);
});

test("the restore CLI lands a trailer-absent export with --legacy at the weaker level", t => {
  const { directory, ndjson } = seeded(t);
  const file = join(directory, "legacy.ndjson");
  writeFileSync(file, case1c(ndjson));
  const out = JSON.parse(execFileSync(process.execPath, [script, "--from", file, "--to", join(directory, "out", "room.sqlite"), "--legacy"], { encoding: "utf8" }));
  assert.equal(out.verified, true);
  assert.equal(out.trailer, "absent");
  assert.equal(out.contentVerification, "watermark-only");
});

test("the restore CLI needs no flag for a trailer-present export", t => {
  const { directory, ndjson } = seeded(t);
  const file = join(directory, "good.ndjson");
  writeFileSync(file, ndjson);
  const out = JSON.parse(execFileSync(process.execPath, [script, "--from", file, "--to", join(directory, "out", "room.sqlite")], { encoding: "utf8" }));
  assert.equal(out.trailer, "verified");
});
