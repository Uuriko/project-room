// Resend magic-link mailer tests: the send function posts to the Resend
// API with the code, and the env resolver returns null without a key so
// the mailer seam stays honestly unconfigured. No network, no real key.
import test from "node:test";
import assert from "node:assert/strict";
import { resendMagicLinkSend, magicLinkMailerFromEnv } from "../server/resend-mailer.mjs";

test("resendMagicLinkSend returns null without an API key", () => {
  assert.equal(resendMagicLinkSend({ apiKey: "", from: "Room <noreply@example.com>" }), null);
  assert.equal(resendMagicLinkSend({ from: "Room <noreply@example.com>" }), null);
  assert.equal(resendMagicLinkSend({ apiKey: "re_123" }), null);
});

test("resendMagicLinkSend posts the code to the Resend API", async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>", fetchFn });
  assert.equal(typeof send, "function");
  await send({ to: "user@example.com", code: "123456", expiresAt: Date.now() + 15 * 60000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer re_test");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.from, "Room <noreply@example.com>");
  assert.equal(body.to, "user@example.com");
  assert.ok(body.text.includes("123456"), "plaintext carries the code");
  assert.ok(body.html.includes("123456"), "html carries the code");
});

test("resendMagicLinkSend throws a clear error on API failure", async () => {
  const fetchFn = async () => ({ ok: false, status: 401, text: async () => "{\"message\":\"bad key\"}" });
  const send = resendMagicLinkSend({ apiKey: "re_bad", from: "Room <noreply@example.com>", fetchFn });
  await assert.rejects(() => send({ to: "user@example.com", code: "123456" }), /HTTP 401/);
});

test("resendMagicLinkSend throws a clear error on network failure", async () => {
  const fetchFn = async () => { throw new Error("socket hangup"); };
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>", fetchFn });
  await assert.rejects(() => send({ to: "user@example.com", code: "123456" }), /socket hangup/);
});

test("magicLinkMailerFromEnv returns null without RESEND_API_KEY", () => {
  assert.equal(magicLinkMailerFromEnv({}), null);
  assert.equal(magicLinkMailerFromEnv({ RESEND_API_KEY: "" }), null);
});

test("magicLinkMailerFromEnv builds a sender from the environment", () => {
  const send = magicLinkMailerFromEnv({
    RESEND_API_KEY: "re_env",
    ROOM_MAGIC_FROM: "Custom <magic@example.com>"
  });
  assert.equal(typeof send, "function");
});

test("magicLinkMailerFromEnv defaults the From address", async () => {
  const calls = [];
  const fetchFn = async (url, options) => { calls.push(options); return { ok: true, status: 200 }; };
  const send = magicLinkMailerFromEnv({ RESEND_API_KEY: "re_env" }, { fetchFn });
  await send({ to: "user@example.com", code: "999999" });
  const body = JSON.parse(calls[0].body);
  assert.ok(body.from.includes("noreply@"), "default From is a noreply address");
});
