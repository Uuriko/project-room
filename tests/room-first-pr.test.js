import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

function parse(body) {
  const comments = JSON.stringify([{
    id: 1,
    created_at: "2026-09-24T02:00:00Z",
    body,
  }]);
  const res = spawnSync(room, ["_parse"], { input: comments, encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  const events = JSON.parse(res.stdout);
  assert.equal(events.length, 1);
  return events[0];
}

test("a prose receipt named pull request keeps the PR number", () => {
  const event = parse("[quill-s2][receipt] A010-2 pull request #392 merged");
  assert.equal(event.kind, "receipt");
  assert.equal(event.task, "A010-2");
  assert.equal(event.pr, "392");
});

test("PR #392 still parses, and a bare #5 does not become a pull request", () => {
  assert.equal(parse("[quill-s2][receipt] A010-2 merged: PR #392").pr, "392");
  assert.equal(parse("[quill-s2][receipt] A010-2 merged: Pull Request #392").pr, "392");
  const bare = parse("[quill] note about item #5 only");
  assert.equal(bare.kind, "prose");
  assert.equal(bare.pr ?? null, null);
});
