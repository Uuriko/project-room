import test from "node:test";
import assert from "node:assert/strict";
import { deploymentConfig, loadConfig, streamIntervalConfig } from "../server/config.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";

test("an empty env loads the Node defaults and does not throw", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 4173);
  assert.equal(cfg.githubRepository, "Uuriko/project-room");
  assert.equal(cfg.githubToken, null);
  const deployment = deploymentConfig(cfg);
  assert.equal(deployment.origin, "http://127.0.0.1:4173");
  assert.equal(deployment.production, false);
  assert.equal(deployment.streamInterval, 250);
  assert.ok(deployment.filename.endsWith(".data/room.sqlite"));
});

test("loading a loaded config returns the same object", () => {
  const cfg = loadConfig({});
  assert.equal(loadConfig(cfg), cfg);
});

test("a Worker deployment value loads, and the Node listen rules still reject it", () => {
  const cfg = loadConfig({ ROOM_DEPLOYMENT: "production" });
  assert.equal(cfg.roomDeployment, "production");
  assert.throws(() => deploymentConfig(cfg), /Unknown deployment mode/);
});

test("null does not read process.env", () => {
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "from-process";
  try {
    assert.equal(loadConfig(null).githubToken, null);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test("GITHUB_TOKEN wins over GH_TOKEN, and an empty token falls through", () => {
  assert.equal(loadConfig({ GITHUB_TOKEN: "app", GH_TOKEN: "cli" }).githubToken, "app");
  assert.equal(loadConfig({ GITHUB_TOKEN: "", GH_TOKEN: "cli" }).githubToken, "cli");
});

test("a loaded config still turns public agent pages on only for exactly 1", () => {
  const on = defaultServerArgs({ store: null, env: loadConfig({ ROOM_PUBLIC_AGENT_PAGES: "1" }), origin: "http://127.0.0.1:4173" });
  const off = defaultServerArgs({ store: null, env: loadConfig({ ROOM_PUBLIC_AGENT_PAGES: "0" }), origin: "http://127.0.0.1:4173" });
  assert.equal(on.publicAgentPages, true);
  assert.equal(off.publicAgentPages, false);
});

test("invalid PORT and stream interval keep their messages", () => {
  assert.throws(() => deploymentConfig({ PORT: "0" }), /Invalid PORT/);
  assert.throws(() => streamIntervalConfig({ ROOM_STREAM_INTERVAL_MS: "10" }), /ROOM_STREAM_INTERVAL_MS must be an integer between 50 and 5000 milliseconds/);
  assert.equal(streamIntervalConfig({}), 250);
});
