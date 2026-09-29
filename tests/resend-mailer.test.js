// Resend magic-link mailer tests: the send function posts to the Resend
// API with the code, and the env resolver returns null without a key so
// the mailer seam stays honestly unconfigured. No network, no real key.
import test from "node:test";
import assert from "node:assert/strict";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
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

test("resendMagicLinkSend includes a one-tap sign-in link when baseUrl is set", async () => {
  const calls = [];
  const fetchFn = async (url, options) => { calls.push(options); return { ok: true, status: 200 }; };
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>", fetchFn });
  await send({ to: "user@example.com", code: "abc123", baseUrl: "https://room.example.com/" });
  const body = JSON.parse(calls[0].body);
  const expected = "https://room.example.com/?magic=abc123&email=user%40example.com";
  assert.ok(body.text.includes(expected), "plaintext carries the sign-in link");
  assert.ok(body.html.includes(`href="${expected.replace(/&/g, "&amp;")}"`), "html links the sign-in button");
  assert.ok(body.html.includes("abc123"), "html keeps the code as fallback");
  assert.equal(body.subject, "Your Project Room sign-in link");
});

test("resendMagicLinkSend falls back to code-only without a baseUrl", async () => {
  const calls = [];
  const fetchFn = async (url, options) => { calls.push(options); return { ok: true, status: 200 }; };
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>", fetchFn });
  await send({ to: "user@example.com", code: "999999" });
  const body = JSON.parse(calls[0].body);
  assert.ok(!body.text.includes("?magic="), "no link without baseUrl");
  assert.ok(body.text.includes("999999"), "code still sent");
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

test("magic email links retain the trusted app path and validated new-tab context", async () => {
  const messages = [];
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>",
    fetchFn: async (_, options) => { messages.push(JSON.parse(options.body)); return { ok: true }; } });
  for (const returnTo of ["/?room=commons", "/?account=1#invite/" + "A".repeat(43), "/#join/" + "B".repeat(43) + "/message/msg-1", "/#code/ABC-DEF-GHJ", "/#join/ABC-DEF-GHJ"]) {
    let captured;
    const mailer = createMagicLinkMailer({ baseUrl: "https://room.example/room", send: async payload => { captured = payload; await send(payload); } });
    await mailer.sendMagicLink({ to: "person+test@example.com", code: "safe-code", returnTo });
    const link = new URL(messages.at(-1).text.split("\n")[2]);
    assert.equal(captured.link, link.href, "captured delivery URL is the same URL sent through Resend");
    const target = new URL(returnTo, "https://unused.example");
    assert.equal(link.origin, "https://room.example");
    assert.equal(link.pathname, "/room/");
    assert.equal(link.hash, target.hash);
    assert.equal(link.searchParams.get("room"), target.searchParams.get("room"));
    assert.equal(link.searchParams.get("account"), target.searchParams.get("account"));
    assert.equal(link.searchParams.get("magic"), "safe-code");
    assert.equal(link.searchParams.get("email"), "person+test@example.com");
  }
  const count = messages.length;
  for (const returnTo of ["//evil.example/", "https://evil.example/", "/?magic=override", "/#join/bad"]) {
    await assert.rejects(() => send({ to: "person@example.com", code: "safe-code", baseUrl: "https://room.example/room", returnTo }), /Invalid magic-link return target/);
  }
  assert.equal(messages.length, count, "invalid targets never call the delivery transport");
});

test("reset mail uses only the reset purpose and notification never carries proof", async () => {
  const messages = [];
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>", fetchFn: async (_, options) => {
    messages.push(JSON.parse(options.body)); return { ok: true };
  } });
  const mailer = createMagicLinkMailer({ baseUrl: "https://room.example/room", send });
  await mailer.sendMagicLink({ to: "owner@example.com", code: "reset-proof", purpose: "password-reset",
    returnTo: "/#join/" + "A".repeat(43) + "/work/task-1" });
  const link = new URL(messages[0].text.split("\n")[2]);
  assert.equal(link.searchParams.get("reset"), "reset-proof");
  assert.equal(link.searchParams.has("magic"), false);
  assert.equal(link.pathname, "/room/");
  assert.equal(link.hash, "#join/" + "A".repeat(43) + "/work/task-1");
  assert.equal(messages[0].subject, "Reset your Project Room password");
  assert.doesNotMatch(messages[0].text, /enter this code/i);
  await mailer.sendPasswordResetNotice({ to: "owner@example.com" });
  assert.equal(messages[1].subject, "Your Project Room password was reset");
  assert.doesNotMatch(messages[1].text + messages[1].html, /reset-proof|replacement-password|[?]reset=/);
  await assert.rejects(() => send({ to: "owner@example.com", code: "proof", purpose: "password-reset" }), /configured app URL/);
});
