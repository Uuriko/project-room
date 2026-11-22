import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewConfig, previewName, previewOrigin, commentBody, COMMENT_MARKER } from "../scripts/preview-env.mjs";

const cfg = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));

test("preview config: own Worker name, no routes or crons, no production env, staging-only vars", () => {
  const out = previewConfig(cfg, 42);
  assert.deepEqual(Object.keys(out.env), ["preview"]);
  const p = out.env.preview;
  assert.equal(p.name, "room-pr-42");
  assert.deepEqual(p.routes, []);
  assert.deepEqual(p.triggers.crons, []);
  assert.equal(p.workers_dev, true);
  assert.equal(p.vars.ROOM_ORIGIN, "https://room-pr-42.getdasha.workers.dev");
  assert.notEqual(p.vars.ROOM_DEPLOYMENT, "production");
  assert.ok(!JSON.stringify(out).includes("room.trydemigod.com"));
  assert.deepEqual(out.routes, []);
  assert.deepEqual(p.durable_objects, cfg.env.staging.durable_objects);
});

test("preview name refuses anything but a PR number", () => {
  assert.throws(() => previewName("1;rm"));
  assert.throws(() => previewName("0"));
  assert.equal(previewOrigin("7"), "https://room-pr-7.getdasha.workers.dev");
});

test("comment carries the marker, URL and both results", () => {
  const body = commentBody({ pr: 3, origin: "https://room-pr-3.getdasha.workers.dev", sha: "abcdef1234",
    smoke: { ok: false, findings: [{ severity: "fail", code: "slow" }] }, parity: { status: "ran", parity: 8, partial: 15, missing: 13 } });
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /room-pr-3\.getdasha/);
  assert.match(body, /fail \(slow\)/);
  assert.match(body, /8 parity \/ 15 partial \/ 13 missing/);
  assert.match(commentBody({ pr: 3, deleted: true }), /deleted/);
});
