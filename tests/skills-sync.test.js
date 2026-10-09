// Fail-first crash-safety tests for scripts/skills-sync.mjs.
//
// Bug under test: syncSkills() copied the new tree to a staging dir, then
// deleted the only good plugin copy (rmSync(SKILLS_COPY)) BEFORE the atomic
// swap (renameSync(staging, SKILLS_COPY)). A crash or failed rename in that
// window destroyed plugins/project-room/skills/ with no recovery material,
// despite the W3-F10 comment claiming a crash "can no longer" do that.
// The hardened swap moves the old copy aside first (rename is atomic) and
// rolls it back if the swap fails, so the previous tree always survives.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkills, skillDrift, skillFiles } from "../scripts/skills-sync.mjs";

const FILES = {
  "alpha/SKILL.md": "# alpha\n",
  "alpha/helper.mjs": "export const x = 1;\n",
  "beta/SKILL.md": "# beta\n",
  "gamma/nested/deep.txt": "deep\n",
};

const writeTree = (root, files) => {
  for (const [name, content] of Object.entries(files)) {
    nodeFs.mkdirSync(join(root, name, ".."), { recursive: true });
    nodeFs.writeFileSync(join(root, name), content);
  }
};
const readTree = root => Object.fromEntries(
  skillFiles(root).map(file => [file, nodeFs.readFileSync(join(root, file), "utf8")]));
const sandbox = t => {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "skills-sync-test-"));
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("syncSkills copies the whole tree byte-identical and leaves drift clean", t => {
  const dir = sandbox(t);
  const sourceDir = join(dir, "source"), copyDir = join(dir, "copy");
  writeTree(sourceDir, FILES);
  const count = syncSkills({ sourceDir, copyDir });
  assert.equal(count, Object.keys(FILES).length);
  assert.deepEqual(readTree(copyDir), FILES);
  assert.deepEqual(skillDrift({ sourceDir, copyDir }), []);
  assert.ok(!nodeFs.existsSync(`${copyDir}.staging`), "no staging dir left behind");
  assert.ok(!nodeFs.existsSync(`${copyDir}.previous`), "no backup dir left behind");
  // Syncing again over an existing copy is a clean no-op.
  syncSkills({ sourceDir, copyDir });
  assert.deepEqual(readTree(copyDir), FILES);
  assert.deepEqual(skillDrift({ sourceDir, copyDir }), []);
});

test("a failed swap never destroys the only good plugin copy", t => {
  const dir = sandbox(t);
  const sourceDir = join(dir, "source"), copyDir = join(dir, "copy");
  writeTree(sourceDir, FILES);
  writeTree(copyDir, { "old/SKILL.md": "# old\n" });
  const before = readTree(copyDir);
  const crashingFs = {
    ...nodeFs,
    renameSync: (src, dst) => {
      if (src.endsWith(".staging") && dst === copyDir) {
        throw Object.assign(new Error("simulated crash at swap"), { code: "EIO" });
      }
      return nodeFs.renameSync(src, dst);
    },
  };
  assert.throws(() => syncSkills({ sourceDir, copyDir, fs: crashingFs }), /simulated crash at swap/);
  assert.deepEqual(readTree(copyDir), before, "previous plugin copy survives the failed swap intact");
  // A plain retry recovers everything and completes the sync.
  syncSkills({ sourceDir, copyDir });
  assert.deepEqual(readTree(copyDir), readTree(sourceDir));
  assert.deepEqual(skillDrift({ sourceDir, copyDir }), []);
  assert.ok(!nodeFs.existsSync(`${copyDir}.staging`) && !nodeFs.existsSync(`${copyDir}.previous`), "no stray dirs after recovery");
});

test("a crashed run (copy gone, backup + staging left) is repaired by the next sync", t => {
  const dir = sandbox(t);
  const sourceDir = join(dir, "source"), copyDir = join(dir, "copy");
  writeTree(sourceDir, FILES);
  writeTree(copyDir, { "old/SKILL.md": "# old\n" });
  // Simulate the crash window: the copy was removed before the swap landed.
  nodeFs.renameSync(copyDir, `${copyDir}.previous`);
  writeTree(`${copyDir}.staging`, FILES);
  syncSkills({ sourceDir, copyDir });
  assert.deepEqual(readTree(copyDir), readTree(sourceDir), "next sync restores a complete copy");
  assert.deepEqual(skillDrift({ sourceDir, copyDir }), []);
  assert.ok(!nodeFs.existsSync(`${copyDir}.staging`) && !nodeFs.existsSync(`${copyDir}.previous`), "no stray dirs after recovery");
});

test("skillDrift reports missing, extra, and differing files", t => {
  const dir = sandbox(t);
  const sourceDir = join(dir, "source"), copyDir = join(dir, "copy");
  writeTree(sourceDir, FILES);
  writeTree(copyDir, { "alpha/SKILL.md": "# alpha\n", "stale.txt": "stale\n" });
  const drift = skillDrift({ sourceDir, copyDir });
  assert.ok(drift.some(line => line.includes("alpha/helper.mjs") && line.includes("missing")), "missing file reported");
  assert.ok(drift.some(line => line.includes("stale.txt") && line.includes("extra")), "extra file reported");
  nodeFs.writeFileSync(join(copyDir, "alpha/SKILL.md"), "# changed\n");
  assert.ok(skillDrift({ sourceDir, copyDir }).some(line => line.includes("alpha/SKILL.md") && line.includes("differs")), "content difference reported");
});
