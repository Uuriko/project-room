import test from "node:test";
import assert from "node:assert/strict";
import { summarizePatch } from "../server/code-drops.mjs";

const QUOTED = [
  'diff --git "a/server/caf\\303\\251.mjs" "b/server/caf\\303\\251.mjs"',
  '--- "a/server/caf\\303\\251.mjs"',
  '+++ "b/server/caf\\303\\251.mjs"',
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

test("summarizePatch decodes a git-quoted non-ASCII path", () => {
  const diff = summarizePatch("diff", Buffer.from(QUOTED));
  assert.deepEqual(diff.files, [{ path: "server/café.mjs", adds: 1, dels: 1 }]);
  const mbox = [
    "From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001",
    "From: Claude <noreply@anthropic.com>",
    "Subject: [PATCH] touch cafe",
    "",
    QUOTED,
  ].join("\n");
  const mailed = summarizePatch("mbox", Buffer.from(mbox));
  assert.equal(mailed.files[0].path, "server/café.mjs");
  assert.equal(mailed.adds, 1);
  assert.equal(mailed.dels, 1);
});
