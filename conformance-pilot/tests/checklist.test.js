import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHECKLIST,
  CHECKLIST_IDS,
  WEIGHT_KINDS,
  contributorsForReturnBrief,
  runConformancePilot
} from "../src/index.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");

test("skeleton documents the conformance checklist", () => {
  assert.deepEqual(CHECKLIST_IDS, [
    "recovery",
    "honesty",
    "c1-c4-verification-first",
    "contributors-events-only"
  ]);
  assert.equal(CHECKLIST.length, 4);
  for (const item of CHECKLIST) {
    assert.ok(item.title);
    assert.ok(item.sources.length > 0);
    assert.ok(item.requires.length > 0);
  }
});

test("Contributors stub is Events-only and mints nothing from messages", () => {
  assert.deepEqual([...WEIGHT_KINDS], ["complete", "verify", "decide", "artifact"]);
  const brief = contributorsForReturnBrief({
    events: [
      { type: "message.posted", actorId: "maya", data: { body: "ack volume" } },
      { type: "message.reaction_set", actorId: "maya", data: { reaction: "ack" } }
    ]
  });
  assert.equal(brief.active_weight, 0);
  assert.deepEqual(brief.lines, []);
  assert.deepEqual(brief.gaps, []);
  assert.equal(brief.status, "blocked");
});

test("package stays isolated from Phase 0 and does not import #17", () => {
  for (const source of collectSources(srcRoot)) {
    assert.doesNotMatch(source.text, /from ["'][^"']*\/server\//);
    assert.doesNotMatch(source.text, /from ["'][^"']*contribution-rollup/);
  }
});

test("placeholder reports the full run is blocked on the published #8 tip", () => {
  const result = runConformancePilot();
  assert.equal(result.executed, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /blocked on published #8 tip for full run/);
  assert.match(result.reason, /no merge until Instinct tip/);
  assert.deepEqual(result.checklist, CHECKLIST_IDS);
});

test.todo(
  "failing placeholder: full run (recovery, honesty, C1–C4 verification-first, Contributors Events-only) waits on published #8 tip"
);

function collectSources(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSources(path));
      continue;
    }
    if (entry.name.endsWith(".js")) {
      files.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  return files;
}
