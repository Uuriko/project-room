import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

// The checked-in Worker config is the staging isolation contract. A deploy
// of env.staging must not attach the public routes or the production
// Durable Object. JSON.parse is what the release checks use, so comments
// are not part of this file.
test("isolated staging owns its Durable Object and does not take production routes", () => {
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(release.name, "project-room-staging");
  assert.equal(release.durable_objects.bindings[0].script_name, "project-room");
  assert.equal(release.env.production.name, "project-room");
  assert.equal(release.env.production.durable_objects.bindings[0].script_name, undefined);
  assert.equal(release.env.production.vars.ROOM_ORIGIN, "https://room.trydemigod.com");
  assert.equal(release.env.production.vars.ROOM_DEPLOYMENT, "production");
  assert.equal(release.env.production.vars.ROOM_PUBLIC_AGENT_PAGES, "0");
  assert.equal(release.env.production.limits.cpu_ms, 30000);
  // The top-level Worker is the public entry door (www.getdasha.com/room). It
  // serves production traffic against the production Durable Object, so its
  // own health, ready and version/worker answers must say production too.
  assert.equal(release.vars.ROOM_DEPLOYMENT, "production");
  assert.equal(release.vars.ROOM_SERVICE_MODE, "cloudflare-production");
  const staging = release.env.staging;
  assert.equal(staging.name, "project-room-stage");
  assert.equal(staging.workers_dev, true);
  assert.deepEqual(staging.routes, []);
  assert.equal(staging.preview_urls, false);
  assert.equal(staging.limits.cpu_ms, 30000);
  assert.deepEqual(staging.triggers.crons, []);
  assert.equal(staging.durable_objects.bindings[0].name, "ROOM");
  assert.equal(staging.durable_objects.bindings[0].class_name, "ProjectRoom");
  assert.equal(staging.durable_objects.bindings[0].script_name, undefined);
  assert.equal(staging.migrations[0].tag, "room-sqlite-v1");
  assert.deepEqual(staging.migrations[0].new_sqlite_classes, ["ProjectRoom"]);
  assert.equal(staging.vars.ROOM_ORIGIN, "https://project-room-stage.getdasha.workers.dev");
  assert.equal(staging.vars.ROOM_DEPLOYMENT, "staging");
  assert.equal(staging.vars.ROOM_GMAIL_ENABLED, "0");
  assert.equal(staging.vars.ROOM_SECURITY_CONTACT, "potter@trydemigod.com");
  assert.equal(release.env.production.vars.ROOM_SECURITY_CONTACT, "potter@trydemigod.com");
});

// A persistent staging database can be ahead of main. An unrelated main push
// must not replace its explicit candidate with an older schema/runtime.
test("persistent staging deploys only an explicitly dispatched candidate", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/staging.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.concurrency.group, "staging-deploy");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const steps = workflow.jobs.deploy.steps;
  const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with?.ref, undefined, "checkout must retain the explicitly selected workflow ref");
  const directory = mkdtempSync(join(resolve(tmpdir()), "staging-argv-"));
  try {
    const origin = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8")).env.staging.vars.ROOM_ORIGIN;
    mkdirSync(join(directory, "bin")); mkdirSync(join(directory, "cloudflare"));
    writeFileSync(join(directory, "cloudflare", "wrangler.jsonc"), JSON.stringify({ env: { staging: { vars: { ROOM_ORIGIN: origin } } } }));
    writeFileSync(join(directory, "bin", "pnpm"), `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2)));console.log(${JSON.stringify(origin)});`, { mode: 0o755 });
    execFileSync("/bin/bash", ["-e", "-c", steps.find(step => step.name === "Deploy isolated staging").run], {
      cwd: join(directory, "cloudflare"), env: { PATH: join(directory, "bin") + ":" + dirname(process.execPath) + ":/usr/bin:/bin", RUNNER_TEMP: directory, ARGV_LOG: join(directory, "argv.json") }, stdio: "pipe"
    });
    const argv = JSON.parse(readFileSync(join(directory, "argv.json"), "utf8"));
    assert.deepEqual(argv.slice(0, 3), ["exec", "wrangler", "deploy"]);
    assert.equal(argv[argv.indexOf("--env") + 1], "staging");
    assert.ok(argv.includes("--keep-vars"));
    assert.equal(argv[argv.indexOf("--durable-objects-code-update-mode") + 1], "deferred 60s");
    assert.ok(!argv.includes("production"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.match(steps.find(step => step.name === "Smoke and browser checks").run, /live-smoke\.mjs --browser/);
});
