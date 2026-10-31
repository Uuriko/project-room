// Preview URLs are a staging-only affordance (dev-mode slice S8a): a branch
// deployed over the staging script becomes reachable at a per-version
// preview URL, while production and the public entry door must never gain
// preview URLs — a preview of the production Worker would serve production
// Durable Objects from an unreviewed URL. This check parses the checked-in
// wrangler config (plain JSON, kept comment-free) and pins exactly that
// split, so a future edit that flips the wrong block fails here first.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const release = JSON.parse(
  await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
);

test("preview URLs are enabled for the staging environment only", () => {
  assert.equal(
    release.env?.staging?.preview_urls,
    true,
    "env.staging must set preview_urls: true (S8a)",
  );
  assert.notEqual(
    release.env?.production?.preview_urls,
    true,
    "env.production must not enable preview_urls",
  );
  assert.notEqual(
    release.preview_urls,
    true,
    "the top-level entry-door Worker must not enable preview_urls",
  );
});

test("the staging environment is the isolated stage Worker, not production", () => {
  // Guards the flip above against landing on the wrong env block: the block
  // carrying preview_urls must be the workers.dev stage script whose vars
  // declare the staging deployment.
  assert.equal(release.env?.staging?.name, "project-room-stage");
  assert.equal(release.env?.staging?.vars?.ROOM_DEPLOYMENT, "staging");
  assert.equal(release.env?.production?.vars?.ROOM_DEPLOYMENT, "production");
});
