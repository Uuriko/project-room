import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createInboxSandbox } from "../scripts/inbox-sandbox.mjs";
test("explicit local inbox sandbox serves the real UI and retains isolated sample data", async t => {
  const sample = await createInboxSandbox();
  t.after(async () => { await sample.close(); rmSync(sample.directory, { recursive: true, force: true }); });
  assert.equal(new URL(sample.url).hostname, "127.0.0.1");
  assert.match(sample.accountKey, /^[A-Za-z0-9_-]{43}$/);
  const response = await fetch(sample.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Send sample/);
  assert.equal((await fetch(new URL("/src/inbox-send-ui.js", sample.url))).status, 200);
});
