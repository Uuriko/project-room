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

const comments = JSON.stringify([
  {
    id: 1, created_at: "2026-09-16T20:10:51Z",
    body: "[quill-s2][receipt] A012-2 inbox rules CRUD + persistence — DONE.\n\n- PR: Uuriko/project-room#392\n- Merge SHA: 681f7359e22caaf4c94c4be9a8b2561546cebcb0 (verified ancestor of origin/main)"
  },
  {
    id: 2, created_at: "2026-09-16T20:24:24Z",
    body: "[quill-s2][receipt] A015-2 digest mode scheduling — done.\n\n- PR: https://github.com/Uuriko/project-room/pull/396\n- Merge commit: e7c0648 (verified ancestor of origin/main)"
  },
  {
    id: 3, created_at: "2026-09-16T20:30:01Z",
    body: "[quill-s2][receipt] B004-2 — room.post MCP wiring — DONE\n\n- PR: #397 — merged via merge commit (all hosted checks green)\n- Merge SHA: fd0e88791520ea2036fa64626768e72b36f494b5 (verified ancestor of origin/main)"
  },
  {
    id: 4, created_at: "2026-09-16T21:00:00Z",
    body: "[quill] just a prose comment, no receipt here"
  }
]);

test("board parser recognizes the [lane][receipt] prose-receipt prefix", () => {
  const events = run(["_parse"], comments);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  assert.equal(byId[1].kind, "receipt");
  assert.equal(byId[1].lane, "quill-s2");
  assert.equal(byId[1].task, "A012-2");
  assert.equal(byId[1].pr, "392");
  assert.equal(byId[1].merged, "681f7359e22caaf4c94c4be9a8b2561546cebcb0");
  assert.equal(byId[2].task, "A015-2");
  assert.equal(byId[2].pr, "396");
  assert.equal(byId[2].merged, "e7c0648");
  assert.equal(byId[3].task, "B004-2");
  assert.equal(byId[3].pr, "397");
  assert.equal(byId[3].merged, "fd0e88791520ea2036fa64626768e72b36f494b5");
  assert.equal(byId[4].kind, "prose");
});

test("prose receipts accumulate into state.prose_receipts", () => {
  const events = JSON.stringify(run(["_parse"], comments));
  const state = run(["_state", "--now", "2026-09-16T22:00:00Z"], events);
  assert.ok(Array.isArray(state.prose_receipts));
  assert.equal(state.prose_receipts.length, 3);
  assert.deepEqual(
    state.prose_receipts.map(r => r.task),
    ["A012-2", "A015-2", "B004-2"]
  );
  assert.equal(state.prose_receipts[0].merged, "681f7359e22caaf4c94c4be9a8b2561546cebcb0");
  assert.equal(state.log.filter(e => e.kind === "receipt" && e.ok).length, 3);
});

test("render does not hardcode watcher=paused", () => {
  const res = spawnSync("grep", ["-c", "watcher=paused", room], { encoding: "utf8" });
  assert.equal(res.stdout.trim(), "0", "scripts/room must not contain a hardcoded watcher=paused signal");
});

test("prose-terminal DONE resolves the task-id from the marker line, not the whole body", () => {
  const fixture = JSON.stringify([
    {
      // Regression for room-watch false positive (2026-09-20): comment
      // 5748168322 is a prose DONE about unrelated PR #718 that only
      // mentions RC-2026-09-19-068 downstream. It must NOT close that
      // task terminally.
      id: 101, created_at: "2026-09-20T06:37:12Z",
      body: "[QA-UX] DONE — first-paint calming merged (PR #718, merge 2dea7916c29bb34748124ee383c7a8e182e82c68).\n\nRebased over #717 with conflicts resolved by hand; QA-Browser owns the suite redness (RC-2026-09-19-068).\n\nDeploying to room.trydemigod.com next."
    },
    {
      // Intended behavior preserved: a task-id named ON the DONE marker
      // line closes the claim; downstream mentions of other RC ids do not
      // hijack the resolution.
      id: 102, created_at: "2026-09-20T07:00:00Z",
      body: "[quill] DONE task-id: RC-2026-09-19-071 — sweep terminal-claim fix.\n\n- PR: #697\n- Merge SHA: 99ab3341\n\nThe decay enforcer still watches RC-2026-09-19-068 for heartbeats."
    }
  ]);
  const events = run(["_parse"], fixture);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  assert.equal(byId[101].kind, "prose");
  assert.equal(byId[102].kind, "done");
  assert.equal(byId[102].ref, "RC-2026-09-19-071");
  assert.equal(byId[102].via, "prose-terminal");
});

test("[lane][receipt] with an RC-style task-id keeps the full id (no truncation)", () => {
  // Regression: first_task ("[A-Z]+[0-9]*-[0-9]+") truncated
  // RC-2026-09-23-103 to "RC-2026", so prose receipts never matched
  // their task. The parser must prefer the full RC id.
  const fixture = JSON.stringify([
    {
      id: 201, created_at: "2026-09-24T00:59:41Z",
      body: "[jill][receipt] RC-2026-09-23-103 — guest bearer-Origin defect repaired.\n\n- PR: #801\n- Merge SHA: 4c75f034f320e533f3c814808a4c5b7e866e3357"
    },
    {
      id: 202, created_at: "2026-09-24T01:00:00Z",
      body: "[jill][receipt] A012-2 still works — old-style ids fall back to first_task.\n\n- PR: #392\n- Merge SHA: 681f7359e22caaf4c94c4be9a8b2561546cebcb0"
    }
  ]);
  const events = run(["_parse"], fixture);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  assert.equal(byId[201].kind, "receipt");
  assert.equal(byId[201].task, "RC-2026-09-23-103");
  assert.equal(byId[201].ref, "RC-2026-09-23-103");
  assert.equal(byId[201].pr, "801");
  assert.equal(byId[202].kind, "receipt");
  assert.equal(byId[202].task, "A012-2");
});

test("[lane][done] without a fenced room-done block parses as done, not a crash", () => {
  // Regression 2026-09-24: parse_events died with
  // "jq: error: split input and separator must be strings" on any
  // [lane][done] comment lacking a ```room-done fence (comment
  // 5822637457), which failed the whole room-watch tick closed.
  // The parser must degrade to the prose task-id instead of crashing.
  const fixture = JSON.stringify([
    {
      id: 301, created_at: "2026-09-24T21:36:07Z",
      body: "[jill][done] RC-2026-09-24-310 containment: PR #980 merged as 144f7dff, all hosted CI green, deployed to production."
    },
    {
      id: 302, created_at: "2026-09-24T21:36:26Z",
      body: "[jill][done] RC-2026-09-24-310-contain\n\n```room-done\ntask-id: RC-2026-09-24-310-contain\npr: 980\nsha: 144f7dffc737d0865041c2db8c7310e9329bb9d6\nreceipt: deployed\n```"
    }
  ]);
  const events = run(["_parse"], fixture);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  assert.equal(byId[301].kind, "done");
  assert.equal(byId[301].lane, "jill");
  assert.equal(byId[301].ref, "RC-2026-09-24-310");
  assert.equal(byId[302].kind, "done");
  assert.equal(byId[302].receipt["task-id"], "RC-2026-09-24-310-contain");
  assert.equal(byId[302].receipt.pr, "980");
  assert.equal(byId[302].receipt.merged, "144f7dffc737d0865041c2db8c7310e9329bb9d6");
});


test('unmarked CLAIM prose is logged without registering a claim', () => {
  const input = JSON.stringify([
    { id: 201, created_at: '2026-09-25T18:00:00Z', body: 'CLAIM: RC-2026-09-23-001 take scripts/room' },
    { id: 202, created_at: '2026-09-25T18:01:00Z', body: 'I might work on the parser.' },
  ]);
  const events = run(['_parse'], input);
  assert.deepEqual(events.map(event => event.kind), ['prose', 'prose']);
  const state = run(['_state', '--now', '2026-09-25T18:02:00Z'], JSON.stringify(events));
  assert.equal(state.tasks.length, 0);
  assert.deepEqual(state.log.map(entry => [entry.id, entry.kind, entry.ok]), [
    [201, 'prose', false], [202, 'prose', false],
  ]);
  assert.match(state.log[0].errors[0], /no recognized structured prefix/);
});
