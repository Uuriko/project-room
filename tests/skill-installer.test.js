import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// #3577: the ProjectRoom skill installer used to fetch SKILL.md +
// AUTO-INVOKE.md (an auto-invoke rule for the user's agent) from the mutable
// `main` branch over an unauthenticated channel. It now copies the payload
// from the checkout it runs in. These tests pin both halves of that fix:
// the local copy works, and no remote fetch returns.

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(root, "skills", "ProjectRoom");
const pluginDir = join(root, "plugins", "project-room", "skills", "ProjectRoom");
const payloads = ["SKILL.md", "AUTO-INVOKE.md"];

test("skill installer copies the payload from its own checkout", (t) => {
  const base = mkdtempSync(join(tmpdir(), "skill-install-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const run = spawnSync("sh", [join(sourceDir, "install.sh"), base], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  for (const f of payloads) {
    assert.equal(
      readFileSync(join(base, ".agents", "skills", "ProjectRoom", f), "utf8"),
      readFileSync(join(sourceDir, f), "utf8"),
      `${f} must be installed byte-identical to the checkout`,
    );
  }
});

test("skill installer refuses to run without its payload beside it", (t) => {
  const lone = mkdtempSync(join(tmpdir(), "skill-install-lone-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(join(sourceDir, "install.sh"), join(lone, "install.sh"));
  const run = spawnSync("sh", [join(lone, "install.sh"), lone], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /full checkout/);
});

test("skill installer performs no remote fetch (both copies)", () => {
  for (const dir of [sourceDir, pluginDir]) {
    const script = readFileSync(join(dir, "install.sh"), "utf8");
    assert.ok(
      !script.includes("raw.githubusercontent.com"),
      `${dir}/install.sh references a raw remote URL again (#3577)`,
    );
    const commands = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.ok(
      !/\b(curl|wget)\b/.test(commands),
      `${dir}/install.sh executes a downloader again (#3577)`,
    );
  }
  assert.equal(
    readFileSync(join(pluginDir, "install.sh"), "utf8"),
    readFileSync(join(sourceDir, "install.sh"), "utf8"),
    "plugin copy of install.sh must stay identical to skills/ (skills-sync)",
  );
});
