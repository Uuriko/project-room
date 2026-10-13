// #2932: googleConfig treats localhost, 127.0.0.1 and [::1] as loopback and
// mints an http redirectUri for each, but GoogleSignIn's constructor only
// permitted http for 127.0.0.1 — so the standard local-dev setup
// (http://localhost:<port>) threw google_configuration_invalid when http.mjs
// fed the googleConfig redirectUri straight into the constructor. The two
// must share one loopback definition; plain http for non-loopback hosts
// stays rejected in both.
import test from "node:test";
import assert from "node:assert/strict";
import { googleConfig, GoogleSignIn, GOOGLE_CALLBACK_PATH } from "../server/google-oauth.mjs";

const clientId = "1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
const clientSecret = "GOCSPX-fixture-secret-never-real"; // secrets-allowlist (fixture value, not a credential)
const env = { ROOM_GOOGLE_CLIENT_ID: clientId, ROOM_GOOGLE_CLIENT_SECRET: clientSecret };

const loopbackOrigins = [
  "http://localhost:3210",
  "http://127.0.0.1:3210",
  "http://[::1]:3210",
];

test("googleConfig mints an http redirectUri for every loopback origin", () => {
  for (const origin of loopbackOrigins) {
    const config = googleConfig(env, origin);
    assert.equal(config.redirectUri, origin + GOOGLE_CALLBACK_PATH, origin);
  }
});

test("GoogleSignIn accepts every redirectUri googleConfig mints (loopback http included)", () => {
  for (const origin of loopbackOrigins) {
    const config = googleConfig(env, origin);
    assert.doesNotThrow(
      () => new GoogleSignIn({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri }),
      origin
    );
  }
});

test("GoogleSignIn accepts https redirect URIs for non-loopback hosts", () => {
  const config = googleConfig(env, "https://room.example");
  assert.doesNotThrow(
    () => new GoogleSignIn({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri })
  );
});

test("plain http for a non-loopback host stays rejected by both googleConfig and GoogleSignIn", () => {
  assert.throws(() => googleConfig(env, "http://room.example"), /Invalid Room Google authentication configuration/);
  assert.throws(
    () => new GoogleSignIn({ clientId, clientSecret, redirectUri: "http://room.example" + GOOGLE_CALLBACK_PATH }),
    { code: "google_configuration_invalid" }
  );
  assert.throws(
    () => new GoogleSignIn({ clientId, clientSecret, redirectUri: "http://192.168.1.10:3210" + GOOGLE_CALLBACK_PATH }),
    { code: "google_configuration_invalid" },
    "a LAN address is not loopback and must not unlock plain http"
  );
});
