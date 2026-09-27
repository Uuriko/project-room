// render_md prose-fence section (2026-09-27, RC-2026-09-27-2726).
//
// The $frows variable was bound twice in render_md: first from
// .unleased_prose_claims (for ## prose-claims-needing-fence), then rebound
// from the file-claims $fmap. The prose section therefore duplicated the
// ## file-claims table instead of listing the unfenced prose comments.
//
// Regression test through a real `rebuild --out` against a fake gh (the
// render path has no fixture verb). FAILS on the pre-fix script, where the
// prose section repeats the file-claims row.
//
// Env: ROOM_SCRIPT overrides the script under test (default: scripts/room).
// Pre-fix check: git show HEAD:scripts/room > .tmp/room-prefix
//                ROOM_SCRIPT=.tmp/room-prefix node --test tests/room-render-prose-fence.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = process.env.ROOM_SCRIPT
  ? resolve(checkout, process.env.ROOM_SCRIPT)
  : join(checkout, "scripts/room");

// One fenced file-claim plus one unfenced [lane][claim] prose comment.
// Post-fix the ## prose-claims-needing-fence section must list the prose
// comment (comment-id | lane | task | at), not repeat the file-claims row.
const comments = JSON.stringify([
  { id: 1, created_at: "2026-09-27T18:00:00Z", updated_at: "2026-09-27T18:00:00Z",
    body: "# Claims board (continued from #266)\n\nFresh claims board." },
  { id: 2, created_at: "2026-09-27T18:00:10Z", updated_at: "2026-09-27T18:00:10Z",
    body: "[jill][claim]\n\n```room-claim\ntask-id: RC-2026-09-27-910\nlane: jill\nfiles: scripts/foo.mjs\nlease: lease=6h\nstate: working\nreason: render test\n```" },
  { id: 3, created_at: "2026-09-27T18:05:00Z", updated_at: "2026-09-27T18:05:00Z",
    body: "[jill][claim]\n\nclaiming this in prose, no fenced block, no paths" },
]);

function fakeGh(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "comments.json"), comments);
  // The board clock must sit inside the fixture era so the 6h claim reads open.
  writeFileSync(join(bin, "gh"), `#!/bin/bash
if [[ "$*" == *"rate_limit"* ]]; then
  printf 'HTTP/2 200\\r\\nDate: Sat, 27 Sep 2026 21:00:00 GMT\\r\\n\\r\\n{}\\n'
  exit 0
fi
if [[ "$*" == *"comments"* ]]; then
  cat ${join(dir, "comments.json")}
  exit 0
fi
printf '{}\\n'
`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function rebuild() {
  const dir = mkdtempSync(join(tmpdir(), "room-render-"));
  const bin = fakeGh(dir);
  const out = join(dir, "ROOM-STATE.md");
  const res = spawnSync(room, ["rebuild", "--out", out], {
    encoding: "utf8", timeout: 60000, cwd: checkout,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      ROOM_ENFORCER_ALLOW_STALE: "1",
    },
  });
  assert.equal(res.status, 0, `rebuild failed: ${res.stderr}`);
  return readFileSync(out, "utf8");
}

const section = (md, name) => {
  const lines = md.split("\n");
  const start = lines.findIndex(l => l === `## ${name}`);
  assert.ok(start >= 0, `missing ## ${name} section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.startsWith("## "));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
};

test("prose-claims-needing-fence lists prose comments, not file-claims rows", () => {
  const md = rebuild();
  const files = section(md, "file-claims");
  assert.match(files, /scripts\/foo\.mjs \| jill \| RC-2026-09-27-910 \| working/,
    "fixture file-claim must render under ## file-claims");
  const prose = section(md, "prose-claims-needing-fence");
  assert.match(prose, /^3 \| jill \|/m,
    "the unfenced prose comment must be listed by comment-id");
  assert.doesNotMatch(prose, /scripts\/foo\.mjs \| jill \| RC-2026-09-27-910/,
    "the prose section must not duplicate the file-claims row");
});
