import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8");
const workflow = parse(source);
const job = workflow.jobs["release-runtime"];

test("a successful prod deploy publishes the runtime from the deployed SHA", () => {
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions.actions, "read");
  for (const name of ["gate", "probe", "deploy"]) {
    assert.equal(workflow.jobs[name].permissions.contents, "read", name);
  }
  assert.equal(workflow.jobs.gate.permissions.actions, "read");
  assert.deepEqual(job.needs, ["gate", "deploy"]);
  assert.match(job.if, /needs\.deploy\.result == 'success'/);
  assert.equal(job.permissions.contents, "write");
  const checkout = job.steps.find(step => String(step.uses).startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ needs.gate.outputs.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
  const pack = job.steps.find(step => step.name === "Package the deployed runtime").run;
  assert.match(pack, /runtime-package\.mjs create "\$GITHUB_WORKSPACE" "\$SHA"/);
  assert.match(pack, /project-room-runtime\.tar\.gz/);
  const publish = job.steps.find(step => step.name === "Publish the runtime release").run;
  assert.match(publish, /TAG="runtime-\$\{DATE\}-\$\{SHORT\}"/);
  assert.match(publish, /gh release create "\$TAG"/);
  assert.match(publish, /--latest/);
  assert.match(publish, /gh release edit "\$TAG"/);
  assert.equal(job.steps.find(step => step.name === "Publish the runtime release").env.GH_TOKEN, "${{ github.token }}");
  assert.doesNotMatch(publish, /echo[^\n]*GH_TOKEN|echo[^\n]*CLOUDFLARE|echo[^\n]*ROOM_RECEIPT_TOKEN|set -x/);
  assert.doesNotMatch(source, /releases\/latest/);
});


// Model GitHub's documented implicit success() for this boolean job condition,
// including transitive ancestors. Evaluate the actual YAML expression rather
// than maintaining a second copy of the release policy. This is a policy test,
// not an execution of GitHub's scheduler.
function releaseEligible({ gate = "success", deploy = "success", probe = "skipped", go = "true", cancelled = false } = {}) {
  const status = {
    cancelled: () => cancelled,
    success: () => [gate, probe, deploy].every(result => result === "success"),
    failure: () => [gate, probe, deploy].includes("failure"),
    always: () => true
  };
  const explicitStatus = /\b(?:success|failure|cancelled|always)\s*\(/.test(job.if);
  return (!explicitStatus ? status.success() : true) && runInNewContext(job.if, {
    ...status, needs: { gate: { result: gate, outputs: { go } }, deploy: { result: deploy } }
  });
}

test("runtime publication survives a skipped optional probe after successful deployment", () => {
  assert.deepEqual(workflow.jobs.deploy.needs, ["gate", "probe"]);
  assert.equal(releaseEligible(), true, "run40824263799: gate/deploy succeeded, optional probe skipped");
  assert.equal(releaseEligible({ probe: "success" }), true);
});

test("runtime publication still refuses cancellation, failed deployment and a closed gate", () => {
  assert.equal(releaseEligible({ cancelled: true }), false);
  assert.equal(releaseEligible({ go: "false" }), false);
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(releaseEligible({ gate: result }), false, `gate ${result}`);
    assert.equal(releaseEligible({ deploy: result }), false, `deploy ${result}`);
  }
});
