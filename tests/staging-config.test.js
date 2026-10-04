import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
