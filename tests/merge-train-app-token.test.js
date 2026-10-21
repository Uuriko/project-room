// Merge train mints GitHub App installation tokens when no static token is set.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { MergeTrain } from "../server/merge-train.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const fakeStore = { db: {} };

test("installation token is minted before a tick when only app credentials are set", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? "" });
    return new Response(JSON.stringify({ token: "inst-token-1", expires_at: new Date(Date.now() + 3600e3).toISOString() }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const train = new MergeTrain(fakeStore).configure({
    env: { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_WEBHOOK_SECRET: "w", MERGE_TRAIN_INSTALLATION_ID: "777" },
    fetchImpl,
  });
  assert.equal(train.token, null);
  const token = await train.refreshToken();
  assert.equal(token, "inst-token-1");
  assert.match(calls[0].url, /\/app\/installations\/777\/access_tokens$/);
  assert.match(calls[0].auth, /^Bearer ey/);
});

test("a static token wins and no app token is minted", async () => {
  let called = false;
  const train = new MergeTrain(fakeStore).configure({
    env: { GITHUB_TOKEN: "static", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_WEBHOOK_SECRET: "w", MERGE_TRAIN_INSTALLATION_ID: "7" },
    fetchImpl: async () => { called = true; throw new Error("no"); },
  });
  assert.equal(await train.refreshToken(), "static");
  assert.equal(called, false);
});

test("missing installation id leaves the train on its static-token path", async () => {
  const train = new MergeTrain(fakeStore).configure({ env: { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_WEBHOOK_SECRET: "w" } });
  assert.equal(await train.refreshToken(), null);
});
