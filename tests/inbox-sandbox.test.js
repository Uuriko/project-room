import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createInboxSandbox } from "../scripts/inbox-sandbox.mjs";
test("deferred local inbox sandbox retains isolated sample data without shipping email UI", async t => {
  const sample = await createInboxSandbox();
  t.after(async () => { await sample.close(); rmSync(sample.directory, { recursive: true, force: true }); });
  assert.equal(new URL(sample.url).hostname, "127.0.0.1");
  assert.equal(new URL(sample.url).hash, "#pr-view/inbox");
  assert.match(sample.accountKey, /^[A-Za-z0-9_-]{43}$/);
  const response = await fetch(sample.url);
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /Send sample|id="inbox-panel"/);
  assert.equal((await fetch(new URL("/src/inbox-send-ui.js", sample.url))).status, 404);
});
