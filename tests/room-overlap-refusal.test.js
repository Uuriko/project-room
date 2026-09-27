// Reducer-level file-overlap refusal (R3, RC-2026-09-27-1145).
//
// Contract: the board reducer (scripts/room rebuild / _parse -> _state)
// must never register a [lane][claim] whose files overlap another lane's
// live claim. The refusal is recorded in .refused (colliding:"files") and
// the log, never silent. Same-lane overlap is allowed. Scoped entries
// ("path (scope text)") follow ROOM-PROTOCOL.md §4e: an unscoped entry
// overlaps any entry on the same path; two scoped entries overlap only on
// an exact (trimmed, case-folded) scope match.
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
// _state output carries tasks as an array (sorted by lease expiry).
const taskOf = (st, task) => st.tasks.find(t => t.task_id === task);
const claim = (id, at, lane, task, files) => C(id, at,
  `[${lane}][claim]\n\n\`\`\`room-claim\ntask-id:    ${task}\nlane:       ${lane}\nfiles:      ${files}\nlease:      lease=6h\nstate:      working\nreason:     overlap-refusal fixture\n\`\`\``);

const okLog = (st, task) => st.log.find(e => e.ok && e.task_id === task);
const refused = (st, task) => st.refused.find(r => r.task_id === task);

test("fenced claim overlapping another lane's live claim is refused, not registered", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-700", "scripts/room"),
    claim(2, "2026-09-27T06:05:00Z", "codex", "RC-2026-09-27-701", "scripts/room"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  // the overlapping claim never lands on the board
  assert.equal(taskOf(st, "RC-2026-09-27-701"), undefined);
  assert.ok(taskOf(st, "RC-2026-09-27-700"), "the first claim holds the files");
  // ... but the refusal is recorded, never silent
  const r = refused(st, "RC-2026-09-27-701");
  assert.ok(r, "refusal must be recorded");
  assert.equal(r.colliding, "files");
  assert.equal(r.by_lane, "codex");
  assert.equal(r.holder_lane, "jill");
  assert.equal(r.holder_task, "RC-2026-09-27-700");
  assert.equal(r.via, "fenced");
  const bad = st.log.find(e => e.kind === "claim" && e.task_id === "RC-2026-09-27-701" && !e.ok);
  assert.ok(bad, "failed claim must appear in the log");
  assert.match(bad.errors.join(" "), /file-overlap refused/);
  assert.match(bad.errors.join(" "), /RC-2026-09-27-700/);
  assert.ok(okLog(st, "RC-2026-09-27-700"), "the first claim logs ok");
});

test("non-overlapping claims from different lanes both register", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-710", "scripts/room"),
    claim(2, "2026-09-27T06:05:00Z", "codex", "RC-2026-09-27-711", "scripts/other.mjs"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.ok(taskOf(st, "RC-2026-09-27-710"));
  assert.ok(taskOf(st, "RC-2026-09-27-711"));
  assert.equal(st.refused.length, 0);
});

test("same-lane overlap registers (same lane never collides with itself)", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-720", "scripts/room"),
    claim(2, "2026-09-27T06:05:00Z", "jill", "RC-2026-09-27-721", "scripts/room"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.ok(taskOf(st, "RC-2026-09-27-720"));
  assert.ok(taskOf(st, "RC-2026-09-27-721"), "same-lane re-claim of the same file is legal");
  assert.equal(st.refused.length, 0);
});

test("unscoped cross-lane claim over a scoped entry is refused", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "instinct", "RC-2026-09-27-730",
      "server/store.mjs (OTel fanout span only)"),
    claim(2, "2026-09-27T06:05:00Z", "codex", "RC-2026-09-27-731", "server/store.mjs"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.ok(taskOf(st, "RC-2026-09-27-730"));
  assert.equal(taskOf(st, "RC-2026-09-27-731"), undefined,
    "unscoped claims the whole file, so it collides with the scoped entry");
  assert.equal(refused(st, "RC-2026-09-27-731").colliding, "files");
});

test("scoped cross-lane claim over an unscoped entry is refused", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "instinct", "RC-2026-09-27-740", "server/store.mjs"),
    claim(2, "2026-09-27T06:05:00Z", "codex", "RC-2026-09-27-741",
      "server/store.mjs (OTel fanout span only)"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.equal(taskOf(st, "RC-2026-09-27-741"), undefined);
  assert.equal(refused(st, "RC-2026-09-27-741").colliding, "files");
});

test("same-scope cross-lane claim is refused; different-scope cross-lane claim registers", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "instinct", "RC-2026-09-27-750",
      "server/store.mjs (OTel fanout span only)"),
    claim(2, "2026-09-27T06:05:00Z", "grokbot", "RC-2026-09-27-751",
      "server/store.mjs (OTel fanout span only)"),
    claim(3, "2026-09-27T06:10:00Z", "grokbot", "RC-2026-09-27-752",
      "server/store.mjs (metrics sink only)"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.equal(taskOf(st, "RC-2026-09-27-751"), undefined,
    "same scope on the same file collides across lanes");
  assert.equal(refused(st, "RC-2026-09-27-751").colliding, "files");
  assert.ok(taskOf(st, "RC-2026-09-27-752"),
    "a different scope on the same file is a different sub-area");
});

test("prose claim overlapping another lane's live claim is refused too", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-760", "scripts/room"),
    C(2, "2026-09-27T06:05:00Z",
      "[codex][claim] RC-2026-09-27-761 prose overlap. Exact files: `scripts/room`"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.equal(taskOf(st, "RC-2026-09-27-761"), undefined);
  const r = refused(st, "RC-2026-09-27-761");
  assert.ok(r);
  assert.equal(r.colliding, "files");
  assert.equal(r.via, "prose");
  assert.equal(r.holder_task, "RC-2026-09-27-760");
});

test("terminal and released claims free their files", () => {
  const comments = [
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-770", "scripts/room"),
    C(2, "2026-09-27T06:30:00Z",
      `[jill][done]\n\n\`\`\`room-done\ntask-id: RC-2026-09-27-770\nlane: jill\npr: 9999\nsha: abc123\nreceipt: done\n\`\`\``),
    claim(3, "2026-09-27T06:35:00Z", "codex", "RC-2026-09-27-771", "scripts/room"),
  ];
  const st = stateOf(comments, "2026-09-27T07:00:00Z");
  assert.ok(taskOf(st, "RC-2026-09-27-771"),
    "a completed claim must not block a later claim on the same files");
  assert.equal(st.refused.length, 0);
});
