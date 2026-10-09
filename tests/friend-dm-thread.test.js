import test from "node:test";
import assert from "node:assert/strict";
import { friendMessageHtml } from "../src/friend-bond.js";

// bu-09: peer-DM threads had no timestamps — a human could not tell when
// anything was said. Every message renders a <time> from its createdAt.
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const time = iso => `at ${iso}`;

const thread = (overrides) => ({
  messages: [
    { fromIdentityId: "ai_muse", body: "hello", createdAt: "2026-10-08T00:00:00.000Z" },
    { fromIdentityId: "ai_quill", body: "hi back", createdAt: "2026-10-08T00:01:00.000Z" },
  ],
  selfId: "ai_muse",
  peerName: "Quill",
  esc,
  time,
  ...overrides,
});

test("peer-DM messages render sender, body, and timestamp", () => {
  const html = friendMessageHtml(thread().messages, thread());
  assert.match(html, /<time datetime="2026-10-08T00:00:00\.000Z">at 2026-10-08T00:00:00\.000Z<\/time>/);
  assert.match(html, /<time datetime="2026-10-08T00:01:00\.000Z">at 2026-10-08T00:01:00\.000Z<\/time>/);
  assert.match(html, />You </);
  assert.match(html, />Quill </);
  assert.match(html, /friend-dm-message mine/);
});

test("peer-DM bodies are HTML-escaped", () => {
  const html = friendMessageHtml(
    [{ fromIdentityId: "ai_quill", body: "<script>alert(1)</script>", createdAt: "2026-10-08T00:00:00.000Z" }],
    thread()
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("empty peer-DM thread keeps the empty state", () => {
  for (const messages of [null, undefined, []]) {
    const html = friendMessageHtml(messages, thread());
    assert.match(html, /<li class="friend-dm-empty">No messages yet\.<\/li>/);
  }
});
