// The no-mailer escape hatch must not be silent: /api/health reports the gate
// state and the process warns once at boot when a server comes up without a mailer.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

async function health(t, options) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(res.status, 200);
  return res.json();
}

test("/api/health reports relaxed-no-mailer without a mailer", async t => {
  assert.equal((await health(t, {})).emailVerification, "relaxed-no-mailer");
});

test("/api/health reports enforced with a configured mailer", async t => {
  const mailer = createMagicLinkMailer({ baseUrl: "https://room.example.invalid", send: async () => {} });
  const body = await health(t, { magicLinkMailer: mailer });
  assert.equal(body.emailVerification, "enforced");
  assert.equal(body.status, "ok");
});

const boot = mailer => {
  const script = `
    import { createAcceptanceFixture } from "./scripts/acceptance-fixture.mjs";
    import { createRoomServer } from "./server/http.mjs";
    import { createMagicLinkMailer } from "./server/magic-links.mjs";
    const f = createAcceptanceFixture();
    const opts = ${mailer} ? { magicLinkMailer: createMagicLinkMailer({ baseUrl: "https://room.example.invalid", send: async () => {} }) } : {};
    createRoomServer({ store: f.store, ...opts }); createRoomServer({ store: createAcceptanceFixture().store, ...opts });
    f.store.close(); process.exit(0);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stderr;
};

test("boot warns once without a mailer and stays quiet with one", () => {
  const warned = boot(false);
  assert.equal(warned.split("email-verification gates are relaxed").length - 1, 1, "exactly one warning for two servers");
  assert.doesNotMatch(boot(true), /email-verification gates are relaxed/);
});
