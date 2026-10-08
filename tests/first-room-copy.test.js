import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FIRST_ROOM_SETUP_FAILURE } from "../src/first-room-copy.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Contract: when the automatic first-room setup fails, the account rooms
// panel must read as a failure with a retry — never as the "you have no
// rooms" empty state. The pre-fix code set "No rooms yet." in both failure
// branches of ensureDefaultRoom(), hiding a real setup failure behind a
// false empty state with no next step (verified live on prod 2026-10-07).

test("first-room setup failure names the failure and the retry", () => {
  assert.match(FIRST_ROOM_SETUP_FAILURE, /couldn.t set up your first room/i,
    "says what happened: the setup failed");
  assert.match(FIRST_ROOM_SETUP_FAILURE, /choose rooms to retry/i,
    "says what to do next: the Rooms navigation re-runs the setup");
});

test("first-room setup failure is not the false empty state", () => {
  assert.ok(!/no rooms yet/i.test(FIRST_ROOM_SETUP_FAILURE),
    "must not read as 'you have no rooms' when setup actually failed");
});

function ensureDefaultRoomBody(app) {
  const start = app.indexOf("async function ensureDefaultRoom()");
  assert.ok(start !== -1, "ensureDefaultRoom still lives in src/app.js");
  let depth = 0, i = app.indexOf("{", start);
  for (; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}") { depth--; if (depth === 0) break; }
  }
  return app.slice(start, i + 1);
}

test("ensureDefaultRoom wires the failure copy and keeps the genuine empty state", () => {
  const app = readFileSync(path.join(repoRoot, "src/app.js"), "utf8");
  assert.ok(app.includes('from "./first-room-copy.js"'),
    "src/app.js imports the first-room copy module");
  const body = ensureDefaultRoomBody(app);
  assert.ok(body.includes("FIRST_ROOM_SETUP_FAILURE"),
    "ensureDefaultRoom uses the failure copy in its failure branches");
  assert.ok(!body.includes("No rooms yet."),
    "ensureDefaultRoom never renders the false 'No rooms yet.' empty state");
  const genuineEmpty = (app.match(/"No rooms yet\."/g) ?? []).length;
  assert.equal(genuineEmpty, 1,
    "the genuine 'No rooms yet.' empty-list branch keeps its copy exactly once");
});
