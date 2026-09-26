// Authoring gate (test-audit skill):
// 1. Protects the invariant that kb/index.md accurately maps all kb files:
//    no orphaned files, no broken links, every file headed. A stale index
//    is worse than none (deep-dive §8), so the mapping is machine-checked.
// 2. Credible regression: a lane adds kb/notes/x.md without linking it in
//    index.md, or a link rots after a rename -> test fails.
// 3. No existing coverage: kb/ is new in this PR.
// 4. No production seam: reads markdown from disk only.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const kbDir = join(checkout, "kb");

function listMd(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

test("kb/index.md exists and links every kb file", () => {
  const indexPath = join(kbDir, "index.md");
  assert.ok(existsSync(indexPath), "kb/index.md must exist");
  const index = readFileSync(indexPath, "utf8");

  // Collect every markdown link target in the index.
  const linked = new Set();
  for (const m of index.matchAll(/\]\(([^)]+)\)/g)) {
    linked.add(m[1]);
  }

  for (const f of listMd(kbDir)) {
    const rel = f.slice(kbDir.length + 1); // e.g. notes/x.md
    if (rel === "index.md") continue;
    const candidates = [`${rel}`, `./${rel}`];
    const found = candidates.some((c) => linked.has(c));
    assert.ok(
      found,
      `kb file ${rel} is not linked from kb/index.md (orphaned note)`
    );
  }
});

test("every link in kb/index.md resolves to a real file", () => {
  const index = readFileSync(join(kbDir, "index.md"), "utf8");
  for (const m of index.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|#|mailto:)/.test(target)) continue; // external/anchor links
    const abs = join(kbDir, target);
    assert.ok(
      existsSync(abs),
      `kb/index.md links to ${target}, which does not exist`
    );
  }
});

test("every kb file starts with a top-level heading", () => {
  for (const f of listMd(kbDir)) {
    const first = readFileSync(f, "utf8").split("\n")[0];
    assert.ok(
      first.startsWith("# "),
      `${f.slice(kbDir.length + 1)} must start with a "# " heading`
    );
  }
});
