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
