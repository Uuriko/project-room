// tests/gmail-live-fixture.test.js — the fixture is a behavior double for the
// real Gmail API: unknown methods on a known message id must 404, exactly as
// production does. A double that 200s on anything hides misspelled client
// calls (the AGENTS.md rule this fixture exists to enforce).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gmailLiveFixture } from "../scripts/gmail-live-fixture.mjs";

const call = async (fetchImpl, url, init) => fetchImpl(url, init);

test("M-50: unknown action on a known message id returns 404, not 200", async () => {
  const { config } = gmailLiveFixture();
  const res = await call(
    config.fetchImpl,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/mail-1/frobnicate",
    { method: "POST", body: "{}" },
  );
  assert.equal(res.status, 404);
});

test("known message actions still work (modify/trash/untrash/get)", async () => {
  const { config } = gmailLiveFixture();
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages/mail-1";
  const get = await call(config.fetchImpl, base, { method: "GET" });
  assert.equal(get.status, 200);
  const modify = await call(config.fetchImpl, `${base}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: ["STARRED"], removeLabelIds: [] }),
  });
  assert.equal(modify.status, 200);
  assert.ok((await modify.json()).labelIds.includes("STARRED"));
  const trash = await call(config.fetchImpl, `${base}/trash`, { method: "POST", body: "{}" });
  assert.equal(trash.status, 200);
  const untrash = await call(config.fetchImpl, `${base}/untrash`, { method: "POST", body: "{}" });
  assert.equal(untrash.status, 200);
});

test("unknown message id still returns 404", async () => {
  const { config } = gmailLiveFixture();
  const res = await call(
    config.fetchImpl,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/nope-9",
    { method: "GET" },
  );
  assert.equal(res.status, 404);
});
