// Owner-boundary regression for the Actions publish decision. GitHub Actions
// push payloads omit commit added/modified/removed lists:
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push
// Execute the actual workflow shell against real, shallow Git repositories.
// Manifest-schema/pinned-action tests cannot detect a silently skipped publish.
// No production seam, provider mock, network service or registry login is used.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github/workflows/mcp-registry-publish.yml"), "utf8"));
const steps = workflow.jobs.publish.steps;
const gate = steps.find((step) => step.id === "gate");
const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
const zero = "0".repeat(40);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "registry-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Registry gate test");
  git(source, "config", "user.email", "registry-test@example.invalid");
  function commit(path, content) {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    if (content === null) rmSync(target); else writeFileSync(target, content);
    git(source, "add", "-A");
    git(source, "commit", "-m", `Change ${path}`);
    return git(source, "rev-parse", "HEAD");
  }
  const initial = commit("server.json", '{"version":"1.0.0"}\n');
  function run({ before = initial, after = git(source, "rev-parse", "HEAD"), payload = {}, env = {}, prepare } = {}) {
    const work = join(dir, "checkout");
    const depth = checkout.with?.["fetch-depth"] ?? 1;
    git(dir, "clone", ...(depth ? ["--depth", String(depth)] : []), "--single-branch", "--branch", "main", pathToFileURL(source).href, work);
    prepare?.(work);
    const eventPath = join(dir, "event.json");
    const outputPath = join(dir, "output");
    // Deliberately no added/removed/modified properties, even on head_commit.
    writeFileSync(eventPath, JSON.stringify({ ref: "refs/heads/main", before, after, deleted: false, commits: [{ id: after }], head_commit: { id: after }, ...payload }));
    writeFileSync(outputPath, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", gate.run], {
      cwd: work, encoding: "utf8", timeout: 15_000,
      env: { ...gitEnv, GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "branch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: after, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, ...env },
    });
    assert.ifError(result.error);
    return { ...result, output: readFileSync(outputPath, "utf8"), work };
  }
  return { source, initial, commit, run };
}

function decision(result, expected) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.output.trim(), `publish=${expected}`, result.stdout);
}

function failed(result) {
  assert.notEqual(result.status, 0, "uncertain input must fail the run");
  assert.equal(result.output, "", "an error must not become a publish/unchanged decision");
  assert.match(result.stdout + result.stderr, /::error::/);
}

test("registry trigger and permission boundary excludes PRs and unrelated branches/tags", () => {
  // GitHub evaluates this declarative boundary; the executable gate is tested below.
  assert.deepEqual(workflow.on, { push: { tags: ["v*"], branches: ["main"] }, workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { "id-token": "write", contents: "read" });
  for (const step of steps.slice(steps.indexOf(gate) + 1)) {
    assert.ok(step.if?.includes("steps.gate.outputs.publish == 'true'"), `${step.name} must require the publish decision`);
  }
});

test("a manifest change early in a multi-commit push publishes from an Actions-shaped shallow checkout", (t) => {
  const f = fixture(t);
  f.commit("server.json", '{"version":"1.1.0"}\n');
  for (let i = 0; i < 5; i++) f.commit("README.md", `Later source commit ${i}\n`);
  const result = f.run({ prepare(work) {
    assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "true");
    assert.notEqual(spawnSync("git", ["cat-file", "-e", f.initial], { cwd: work }).status, 0);
  } });
  decision(result, true);
});

for (const path of ["README.md", "docs/server.json", ".github/workflows/mcp-registry-publish.yml"]) {
  test(`an unchanged manifest does not publish old backlog when only ${path} changes`, (t) => {
    const f = fixture(t);
    f.commit(path, "Source-only change\n");
    decision(f.run(), false);
  });
}

test("a manifest changed and reverted within one push does not republish the same tree", (t) => {
  const f = fixture(t);
  f.commit("server.json", '{"version":"1.1.0"}\n');
  f.commit("server.json", '{"version":"1.0.0"}\n');
  decision(f.run(), false);
});

test("a force push compares its non-ancestor before/after endpoints, not HEAD's parent", (t) => {
  const f = fixture(t);
  const before = f.commit("server.json", '{"version":"1.1.0"}\n');
  git(f.source, "checkout", "-b", "replacement", f.initial);
  f.commit("README.md", "Replacement history\n");
  git(f.source, "branch", "-f", "main", "HEAD");
  // The old object remains available in the same origin, but not in the clone.
  decision(f.run({ before }), true);
});

test("new main branch uses an empty before tree", (t) => {
  decision(fixture(t).run({ before: zero }), true);
});

test("a deleted branch skips without trying to resolve its zero after SHA", (t) => {
  decision(fixture(t).run({ after: zero, payload: { deleted: true } }), false);
});

test("removing server.json fails before the authentication and publication gates", (t) => {
  const f = fixture(t);
  f.commit("server.json", null);
  failed(f.run());
});

for (const [name, env] of [
  ["manual dispatch", { GITHUB_EVENT_NAME: "workflow_dispatch" }],
  ["version tag", { GITHUB_REF_TYPE: "tag", GITHUB_REF: "refs/tags/v1.2.0" }],
]) {
  test(`${name} still publishes without needing push comparison fields`, (t) => {
    const result = fixture(t).run({ payload: { before: null, after: null }, env });
    decision(result, true);
    if (env.GITHUB_REF_TYPE === "tag") {
      const versionStep = steps.find((step) => step.name === "Set version from tag");
      execFileSync("bash", ["-e", "-c", versionStep.run], { cwd: result.work, env: { ...gitEnv, ...env } });
    }
    assert.equal(JSON.parse(readFileSync(join(result.work, "server.json"))).version, env.GITHUB_REF_TYPE === "tag" ? "1.2.0" : "1.0.0");
  });
}

for (const payload of [{ before: null }, { before: "--upload-pack=unexpected" }, { after: "not-a-sha" }]) {
  test(`invalid event endpoints fail visibly: ${JSON.stringify(payload)}`, (t) => {
    failed(fixture(t).run({ payload }));
  });
}

test("unavailable old commit fails visibly instead of silently declaring no change", (t) => {
  failed(fixture(t).run({ before: "1".repeat(40) }));
});

test("checkout/event mismatch fails before making a publish decision", (t) => {
  const f = fixture(t);
  f.commit("README.md", "newer commit\n");
  failed(f.run({ after: f.initial }));
});


test("a real git diff error is not mistaken for a changed or unchanged manifest", (t) => {
  const f = fixture(t);
  const payload = {};
  const result = f.run({ payload, prepare(work) {
    const brokenCommit = `tree ${"f".repeat(40)}\nparent ${f.initial}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nMissing tree\n`;
    payload.after = execFileSync("git", ["hash-object", "-w", "-t", "commit", "--stdin"], { cwd: work, env: gitEnv, input: brokenCommit, encoding: "utf8" }).trim();
    git(work, "update-ref", "HEAD", payload.after);
  } });
  failed(result);
  assert.match(result.stdout, /Cannot compare push trees/);
});
