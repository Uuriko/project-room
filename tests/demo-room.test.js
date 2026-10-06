// Wave-2 human-UX #1599: unauthenticated visitors get a real public surface.
// GET /demo serves a labeled demo-room snapshot (script-free HTML) carrying
// one illustrative sanitized conversation, and the logged-out hero links to
// it. The demo is curated static content: it must never carry live room data,
// member PII, or anything an opt-in did not publish.
//
// Authoring gate:
// 1. Behavior: an unauthenticated GET /demo returns 200 with the demo
//    conversation; the logged-out hero (static + auth) links to /demo.
// 2. Regressions: the route deleted or accidentally auth-gated (evaluators
//    bounce off the wall again); the hero link removed (surface exists but
//    is undiscoverable); curated content replaced with live-store reads
//    (private data leaks to anonymous visitors).
// 3. No existing coverage: /demo does not exist; the static-hero tests guard
//    the existing doors only.
// 4. No production seam: demoRoomView() takes no store argument — privacy by
//    construction, not by a flag.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { demoRoomView } from "../server/public-rooms.mjs";
import { ABUSE_EMAIL } from "../server/legal-pages.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-demo-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /demo is a public, script-free demo room page", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/demo`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  // Exactly one h1 (public-pages-hygiene contract).
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.match(html, /<main>/);
  // The page is labeled as a demo snapshot, never mistaken for live data.
  assert.match(html, /[Dd]emo snapshot/);
  assert.match(html, /not a live room|illustrative/i);
  // One sanitized conversation: handles, messages, tasks, receipts.
  assert.match(html, /Mara/);
  assert.match(html, /Scout/);
  assert.match(html, /triage/i);
  assert.match(html, /Open tasks/);
  assert.match(html, /Public receipts/);
  // Crawler metadata like the other acquisition pages.
  assert.match(html, /rel="canonical" href="https:\/\/room\.trydemigod\.com\/demo"/);
  assert.match(html, /property="og:title"/);
  assert.ok(!html.includes("<script"), "no scripts on the public page");
});

test("GET /demo is byte-identical across requests: no live data", async t => {
  // The demo renders from curated static content. Two anonymous fetches must
  // return identical bytes — a per-request store read would break this and
  // would be the leak vector for private room data.
  const origin = await serve(t);
  const first = await (await fetch(`${origin}/demo`)).text();
  const second = await (await fetch(`${origin}/demo`)).text();
  assert.equal(first, second);
});

test("GET /demo carries no PII, ids, or secrets (fail closed)", async t => {
  const origin = await serve(t);
  const html = await (await fetch(`${origin}/demo`)).text();
  // The only address on the page is the published abuse contact in the legal
  // footer — public on every site page by design. Any other address is a leak.
  const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  assert.deepEqual(emails.filter(address => address !== ABUSE_EMAIL), [], "no leaked email addresses");
  assert.ok(html.includes(ABUSE_EMAIL), "the abuse contact stays reachable");
  assert.equal(html.includes("pub1."), false, "no public-face codes");
  assert.equal(/\bai_[A-Za-z0-9_-]{8,}/.test(html), false, "no member/agent ids");
  assert.equal(/\b[a-f0-9]{64}\b/.test(html), false, "no 64-hex secret-looking strings");
  assert.equal(html.includes("__Host-"), false, "no session cookie names");
});

test("demoRoomView renders without any store: privacy by construction", () => {
  // The view takes no store/db argument, so no code path can smuggle live
  // room state into the page. It renders from the frozen curated snapshot.
  const page = demoRoomView();
  assert.ok(page && typeof page.html === "string" && page.html.length > 0);
  assert.equal(typeof page.document, "object");
  assert.equal(page.document.schema, "project-room-demo-room/1");
});

test("POST /demo is rejected; HEAD /demo works", async t => {
  const origin = await serve(t);
  const post = await fetch(`${origin}/demo`, { method: "POST" });
  assert.equal(post.status, 405);
  const head = await fetch(`${origin}/demo`, { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("the static hero links the demo room for no-JS strangers", () => {
  // Same retention rationale as tests/static-hero-nojs.test.js: the bytes of
  // index.html ARE the contract for no-JS visitors, and the assertion fails
  // exactly when the discovery contract changes.
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<a href="\/demo">See a demo room<\/a>/, "static hero links the demo room");
});

test("the logged-out auth hero links the demo room", () => {
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const hero = html.match(/<section id="auth-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<a href="\/demo">See a demo room<\/a>/, "auth hero links the demo room");
});
