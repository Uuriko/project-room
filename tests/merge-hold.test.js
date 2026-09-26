// tests/merge-hold.test.js — machine-readable main-merge holds.
// Contract guarded: a lane running `merge-hold.mjs check` right before a
// merge gets exit 3 while the newest hold block is in force, and exit 0 once
// it expires or is lifted. On 2026-09-26 two PRs merged during prose holds;
// this is the check that would have stopped them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeHold, holdBlock, holdBlocks } from "../scripts/merge-hold.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const hold = (id, at, until, by = "codex") => ({ id, created_at: at, body: `[${by}] release in flight\n\n${holdBlock({ until, by, reason: "release #1104 CI" })}` });

test("the newest hold is active until it expires, and a lift ends it early", () => {
  const board = [
    { id: 1, created_at: "2026-09-26T21:30:00Z", body: "prose: please hold merges until 22:00" },
    hold(2, "2026-09-26T21:52:00Z", "2026-09-26T22:20:00Z"),
  ];
  assert.equal(activeHold(board, { now: "2026-09-26T22:00:00Z" }).by, "codex");
  assert.equal(activeHold(board, { now: "2026-09-26T22:21:00Z" }), null);
  const lifted = [...board, { id: 3, created_at: "2026-09-26T22:05:00Z", body: "```room-hold\nscope: main-merges\nuntil: now\nby: codex\nreason: deployed\n```" }];
  assert.equal(activeHold(lifted, { now: "2026-09-26T22:06:00Z" }), null);
});

test("check exits 3 during a hold so a merge script can stop", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "merge-hold-"));
  const file = join(dir, "comments.json");
  writeFileSync(file, JSON.stringify([hold(2, "2026-09-26T21:52:00Z", "2026-09-26T22:20:00Z")]));
  const run = now => {
    try { execFileSync(process.execPath, [join(root, "scripts", "merge-hold.mjs"), "check", "--comments", file, "--now", now], { stdio: "pipe" }); return 0; }
    catch (error) { return error.status; }
  };
  assert.equal(run("2026-09-26T22:00:00Z"), 3);
  assert.equal(run("2026-09-26T22:30:00Z"), 0);
});

// Codex's real hold from #266 (comment 5850263214): the release PR it names
// in exempt-pr may merge; any other PR is held.
const codexHold = { id: 5850263214, created_at: "2026-09-26T22:00:17Z", body: "[codex] Claude: structured hold works; include exempt-pr for the release PR itself.\n\n```room-hold\nscope: main-merges\nuntil: 2026-09-26T22:20:00Z\nby: codex\nexempt-pr: 1104\nreason: release #1104 exact-head CI and serialized production upload\n```\n" };

test("exempt-pr lets the release PR through and still holds every other PR", () => {
  const active = activeHold([codexHold], { now: "2026-09-26T22:10:00Z" });
  assert.deepEqual(active.exemptPrs, [1104]);
  assert.equal(holdBlocks(active, 1104), false);
  assert.equal(holdBlocks(active, 1105), true);
  assert.equal(holdBlocks(active, null), true);
});
