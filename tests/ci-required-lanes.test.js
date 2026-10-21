import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", ".github", "workflows");
const read = name => readFileSync(join(dir, name), "utf8");
const onBlock = text => (text.match(/^on:\n((?:(?:[ #].*)?\n)*)/m) ?? ["", ""])[1];

const NIGHTLY = ["invariants.yml", "mime-fuzz.yml", "qa2-agent-eval.yml", "qa3-gates.yml", "zero-bug-quarantine.yml"];

test("moved checks no longer run per PR and are reusable", () => {
  for (const name of NIGHTLY) {
    const on = onBlock(read(name));
    assert.doesNotMatch(on, /^\s+pull_request:/m, `${name} must not run per PR`);
    assert.match(on, /^\s+workflow_call:/m, `${name} must be callable from nightly.yml`);
  }
});

test("nightly.yml calls every moved check once, on a schedule", () => {
  const nightly = read("nightly.yml");
  assert.match(onBlock(nightly), /schedule:/);
  for (const name of NIGHTLY) {
    assert.equal(nightly.split(`uses: ./.github/workflows/${name}`).length - 1, 1, name);
  }
});

test("required PR lanes and the safety workflows are unchanged", () => {
  for (const name of ["test.yml", "schema-gate.yml"]) assert.match(onBlock(read(name)), /^\s+pull_request:/m, name);
  for (const name of ["zero-bug-gates.yml", "pin-gate.yml"]) assert.match(onBlock(read(name)), /^\s+pull_request:/m, `${name} security lane stays per PR`);
  const files = readdirSync(dir);
  for (const name of ["live-smoke.yml", "rollback-prod.yml", "deploy-prod.yml", "auto-revert.yml"]) assert.ok(files.includes(name), name);
  assert.match(read("deploy-prod.yml"), /workflows: \[test, schema-gate\]/);
});

test("moved checks use per-run concurrency so nightly jobs never cancel each other", () => {
  for (const name of NIGHTLY) assert.match(read(name), /^  group: [a-z0-9-]+-\$\{\{ github\.run_id \}\}$/m, name);
});
