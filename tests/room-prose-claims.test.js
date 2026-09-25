import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

function run(args, stdin) {
  const res = spawnSync(room, args, { input: stdin, encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, `scripts/room ${args.join(" ")} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function parse(comments) {
  return run(["_parse"], JSON.stringify(comments));
}

function stateOf(comments, now) {
  const events = JSON.stringify(parse(comments));
  return run(["_state", "--now", now], events);
}

const C = (id, at, body) => ({ id, created_at: at, body });

test("spaced and reordered [lane][claim] headers are parsed", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[ claim ][ quill-s2 ] B099-2 build the thing. Exact files: `src/foo.mjs`"),
    C(2, "2026-09-17T00:51:00Z",
      "[quill-s2] [claim] B101-2 spaced pair. Exact files: `src/bar.mjs`"),
  ];
  const events = parse(comments);
  assert.equal(events[0].kind, "prose-claim");
  assert.equal(events[0].lane, "quill-s2");
  assert.equal(events[0].prefix, "[claim]");
  assert.equal(events[0].task_id, "B099-2");
  assert.equal(events[1].kind, "prose-claim");
  assert.equal(events[1].lane, "quill-s2");
  assert.equal(events[1].task_id, "B101-2");
});

test("prose claim with backtick files becomes a lease-bearing event", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[quill-s2][claim] B099-2 build the thing. Exact files: `src/foo.mjs`, `tests/foo.test.js`"),
  ];
  const events = parse(comments);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "prose-claim");
  assert.equal(events[0].task_id, "B099-2");
  assert.equal(events[0].lane, "quill-s2");
  assert.deepEqual(events[0].files, ["src/foo.mjs", "tests/foo.test.js"]);

  const st = stateOf(comments, "2026-09-17T01:00:00Z");
  const task = st.tasks.find(t => t.task_id === "B099-2");
  assert.ok(task, "prose claim must create a board task");
  assert.equal(task.lane, "quill-s2");
  assert.equal(task.state, "submitted");
  assert.equal(task.lease, "lease=12h");
  assert.equal(task.lease_h, 12);
  assert.deepEqual(task.files, ["src/foo.mjs", "tests/foo.test.js"]);
  assert.equal(task.claim_id, 1);
  // lease clock starts at the claim comment: 00:50 + 12h = 12:50 UTC
  assert.equal(task.lease_expires_at, "2026-09-17T12:50:00Z");
  assert.equal(task.prose, true);
  const log = st.log.find(e => e.kind === "prose-claim" && e.ok);
  assert.ok(log, "ok prose-claim must be logged");
  assert.equal(log.task_id, "B099-2");
});

test("prose claim via a files: line is parsed too", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[quill-s2][claim] B101-2 files line style\nfiles: scripts/alpha.mjs, tests/alpha.test.js"),
  ];
  const events = parse(comments);
  assert.equal(events[0].kind, "prose-claim");
  assert.equal(events[0].task_id, "B101-2");
  assert.deepEqual(events[0].files, ["scripts/alpha.mjs", "tests/alpha.test.js"]);
});

test("prose claim without files becomes visible as needing fencing, never silent", () => {
  const comments = [
    C(7, "2026-09-17T00:51:00Z",
      "[quill-s2][claim] B100-2 thinking about the thing, no files named yet"),
  ];
  const events = parse(comments);
  assert.equal(events[0].kind, "unleased-prose-claim");
  assert.equal(events[0].lane, "quill-s2");

  const st = stateOf(comments, "2026-09-17T01:00:00Z");
  // no lease-bearing task is created …
  assert.equal(st.tasks.find(t => t.task_id === "B100-2"), undefined);
  // … but the claim is visible, not dropped
  assert.equal(st.unleased_prose_claims.length, 1);
  assert.equal(st.unleased_prose_claims[0].comment_id, 7);
  assert.equal(st.unleased_prose_claims[0].lane, "quill-s2");
  assert.equal(st.unleased_prose_claims[0].task, "B100-2");
  const log = st.log.find(e => e.kind === "unleased-prose-claim");
  assert.ok(log, "unleased prose claim must appear in the log");
  assert.equal(log.ok, false);
  assert.match(log.errors.join(" "), /needs fencing/);
});

test("duplicate prose claim on the same task-id is refused (guard fires)", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[quill-s2][claim] B099-2 first. Files: `src/a.mjs`"),
    C(2, "2026-09-17T00:55:00Z",
      "[quill-s2][claim] B099-2 second try. Files: `src/b.mjs`"),
  ];
  const st = stateOf(comments, "2026-09-17T01:00:00Z");
  const tasks = st.tasks.filter(t => t.task_id === "B099-2");
  assert.equal(tasks.length, 1, "only the first prose claim holds the task-id");
  assert.deepEqual(tasks[0].files, ["src/a.mjs"]);
  assert.equal(st.refused.length, 1);
  assert.equal(st.refused[0].task_id, "B099-2");
  assert.equal(st.refused[0].via, "prose");
  const bad = st.log.find(e => e.kind === "prose-claim" && !e.ok);
  assert.ok(bad);
  assert.match(bad.errors.join(" "), /duplicate claim refused/);
});

test("prose claim cannot steal a fenced claim's task-id", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[quill-s2][claim] fenced first\n\n```room-claim\ntask-id:    RC-2026-09-17-002\nlane:       quill-s2\nfiles:      scripts/room\nlease:      lease=24h\nstate:      submitted\nreason:     fenced stays fenced\n```"),
    C(2, "2026-09-17T00:55:00Z",
      "[quill-s2][claim] RC-2026-09-17-002 prose replay. Files: `scripts/room`"),
  ];
  const st = stateOf(comments, "2026-09-17T01:00:00Z");
  const task = st.tasks.find(t => t.task_id === "RC-2026-09-17-002");
  assert.ok(task);
  assert.equal(task.lease, "lease=24h", "fenced lease untouched by the prose replay");
  assert.equal(task.prose || null, null, "fenced task is not marked prose");
  assert.equal(st.refused.length, 1);
  assert.equal(st.refused[0].task_id, "RC-2026-09-17-002");
});

test("existing fenced claim grammar is byte-identical in behavior", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[quill-s2][claim] fenced\n\n```room-claim\ntask-id:    RC-2026-09-17-003\nlane:       quill-s2\nfiles:      scripts/room\nlease:      lease=24h\nstate:      submitted\nreason:     keep me exactly\n```"),
  ];
  const events = parse(comments);
  assert.equal(events[0].kind, "claim");
  assert.deepEqual(events[0].block, {
    "task-id": "RC-2026-09-17-003",
    lane: "quill-s2",
    files: "scripts/room",
    lease: "lease=24h",
    state: "submitted",
    reason: "keep me exactly",
  });
  const st = stateOf(comments, "2026-09-17T01:00:00Z");
  const task = st.tasks.find(t => t.task_id === "RC-2026-09-17-003");
  assert.ok(task);
  assert.equal(task.lease_h, 24);
  assert.equal(task.prose || null, null);
  // prose machinery must not invent anything for a fenced claim
  assert.equal(st.unleased_prose_claims.length, 0);
  assert.equal(st.log.filter(e => e.kind === "prose-claim").length, 0);
});

test("non-path backticks and parent-dir escapes are not claimed as files", () => {
  const comments = [
    C(1, "2026-09-17T00:50:00Z",
      "[quill-s2][claim] B102-2 careful. Run `npm test`, avoid `../secret`, see `README`"),
  ];
  const events = parse(comments);
  // `npm test` has a space, `../secret` escapes, `README` is not a path —
  // none qualify, so this surfaces as needing fencing rather than a lease.
  assert.equal(events[0].kind, "unleased-prose-claim");
});


test('bare lease value is rejected with a concrete correction', () => {
  const comments = [C(600, '2026-09-25T18:00:00Z', `[quill-s2][claim]\n\`\`\`room-claim
 task-id: RC-2026-09-25-600
 lane: quill-s2
 files: scripts/room
 lease: 6h
 state: working
 reason: test bad lease
\`\`\``)];
  const state = stateOf(comments, '2026-09-25T18:02:00Z');
  assert.equal(state.tasks.length, 0);
  assert.equal(state.log[0].ok, false);
  assert.match(state.log[0].errors.join(' '), /did you mean lease=6h\?/);
});

test('a spaced lane tag is a visible warning, never a registered claim', () => {
  const comments = [
    C(501, '2026-09-25T18:00:00Z', '[Grok Bot][claim] RC-2026-09-25-501 Exact files: `scripts/room`'),
    C(502, '2026-09-25T18:01:00Z', '[claim][Grok Bot] RC-2026-09-25-502 Exact files: `scripts/a.mjs`'),
  ];
  const events = parse(comments);
  assert.deepEqual(events.map(event => event.kind), ['lane-tag-unparseable', 'lane-tag-unparseable']);
  const state = stateOf(comments, '2026-09-25T18:02:00Z');
  assert.equal(state.tasks.length, 0);
  assert.equal(state.log.filter(event => event.kind === 'lane-tag-unparseable' && !event.ok).length, 2);
  assert.match(state.log[0].errors[0], /lane tag contains spaces/);
});


test('ordinary display-name prose is not mistaken for a malformed claim', () => {
  const [event] = parse([C(503, '2026-09-25T18:03:00Z', '[Grok Bot] discussing a possible claim')]);
  assert.equal(event.kind, 'prose');
});
