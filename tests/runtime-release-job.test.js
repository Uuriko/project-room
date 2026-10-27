import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

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
