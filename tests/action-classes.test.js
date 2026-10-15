// W4-44 H2: observe/draft/act separation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { COMMAND_TYPES } from "../server/store.mjs";
import { ACTION_CLASSES, SURFACE_CLASSES, classifyCommand, surfaceClass, ACT_ONLY_EFFECTS } from "../server/action-classes.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("every command type and every out-of-band surface carries exactly one class", () => {
  const classified = [...ACTION_CLASSES.observe, ...ACTION_CLASSES.draft, ...ACTION_CLASSES.act];
  assert.equal(new Set(classified).size, classified.length, "classes are disjoint");
  assert.deepEqual([...classified].sort(), [...COMMAND_TYPES].sort(), "every accepted command type is classified");
  for (const type of COMMAND_TYPES) assert.ok(classifyCommand(type));
  assert.ok(Object.keys(SURFACE_CLASSES).length >= 8, "out-of-band command surfaces are named");
  for (const name of Object.keys(SURFACE_CLASSES)) assert.ok(surfaceClass(name));
  assert.throws(() => classifyCommand("bogus.type"), /Unclassified/);
  assert.throws(() => surfaceClass("bogus"), /Unclassified/);
});

test("message posts and session launches are act-class; reminder scheduling is draft-class", () => {
  assert.equal(classifyCommand(T.MESSAGE_POSTED), "act");
  assert.equal(classifyCommand(T.SESSION_STARTED), "act");
  assert.equal(classifyCommand(T.CLAIM_ACQUIRED), "act");
  assert.equal(classifyCommand(T.NOTIFICATION_PREFERENCES_SET), "draft");
  assert.equal(surfaceClass("private-reminders"), "draft");
  assert.ok(ACT_ONLY_EFFECTS.includes(T.MESSAGE_POSTED) && ACT_ONLY_EFFECTS.includes(T.SESSION_STARTED));
});

// Every module specifier a source file can pull in, in every syntax form:
// static imports (either quote style, multiline bindings, no semicolon),
// side-effect imports, re-exports, and dynamic import() calls (string or
// plain template literal). A single-form regex misses the other forms, so a
// module could gain a capability while its extracted "imports" still equal
// the allowlist. Anything whose specifier is not a plain literal (a dynamic
// import of a variable or interpolated template, an unparseable import) is
// reported as opaque so the allowlist fails closed instead of skipping it.
function moduleSpecifiers(source) {
  const specifiers = [];
  const spans = [];
  const capture = (pattern, group) => {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[group]);
      spans.push([match.index, match.index + match[0].length]);
    }
  };
  capture(/\b(?:import|export)\b[^'";`]*?\bfrom\s*(["'])([^"']+)\1/g, 2);
  capture(/\bimport\s*(["'])([^"']+)\1/g, 2);
  capture(/(?<![\w$.])import\s*\(\s*(["'])([^"']+)\1\s*\)/g, 2);
  capture(/(?<![\w$.])import\s*\(\s*`([^`${]+)`\s*\)/g, 1);
  const masked = [...source];
  for (const [start, end] of spans) {
    for (let i = start; i < end; i++) if (masked[i] !== "\n") masked[i] = " ";
  }
  const rest = masked.join("").replace(/\bimport\.meta\b/g, match => " ".repeat(match.length));
  const opaque = [];
  if (/\bimport\b/.test(rest)) opaque.push("<import syntax the allowlist cannot see>");
  if (/\bexport\b[^;]*\bfrom\b/.test(rest)) opaque.push("<re-export syntax the allowlist cannot see>");
  return { specifiers, opaque };
}

test("the reminder module never imports a send, post, session or spend capability", () => {
  const source = readFileSync(new URL("../server/reminders.mjs", import.meta.url), "utf8");
  const { specifiers, opaque } = moduleSpecifiers(source);
  assert.deepEqual(opaque, [], "every import in the reminder module is a plain literal the allowlist can see");
  assert.deepEqual(specifiers.sort(), ["../src/events.js", "../src/workflow.js", "./store.mjs", "node:crypto"].sort(),
    "the draft-class reminder path keeps its minimal dependencies");
});

test("the reminder import allowlist extraction sees every import syntax form", () => {
  const forms = [
    'import { x } from "node:os";',
    "import { x } from 'node:os';",
    "import {\n  x,\n} from 'node:os';",
    'import "node:os";',
    "import 'node:os'",
    'export { x } from "node:os";',
    "export * as ns from 'node:os';",
    'const p = import("node:os");',
    "const p = import( 'node:os' );",
    "const p = import(`node:os`);",
  ];
  for (const form of forms) {
    const { specifiers, opaque } = moduleSpecifiers(form);
    assert.deepEqual(specifiers, ["node:os"], form);
    assert.deepEqual(opaque, [], form);
  }
  for (const form of ["const p = import(name);", "const p = import(`node:${name}`);", "import x from name;"]) {
    assert.ok(moduleSpecifiers(form).opaque.length > 0, form);
  }
});

test("done-when: enabling a reminder posts no message and launches no session or paid work", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const before = f.store.snapshot(f.keys.owner, "commons");
  const actCount = () => f.store.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE room_id='commons' AND json_extract(body,'$.type') IN (${ACT_ONLY_EFFECTS.map(() => "?").join(",")})`)
    .all(...ACT_ONLY_EFFECTS)[0].n;
  const actBefore = actCount();
  const enable = f.store.reminders.mutate(f.keys.owner, "commons", {
    requestId: randomUUID(), workItemId: "test-handoff", expectedRevision: 0, action: "schedule", dueAt: Date.now() + 3600000,
  });
  assert.equal(enable.duplicate, false);
  const after = f.store.snapshot(f.keys.owner, "commons");
  assert.equal(after.sequence, before.sequence, "reminder enablement appends no room events at all");
  assert.equal(actCount(), actBefore, "no act-class event (message post, session start, claim) is added by enabling a reminder");
  assert.deepEqual(after.state.workItems["test-handoff"], before.state.workItems["test-handoff"],
    "the work item is untouched: no session, no claim, no lifecycle move");
});
