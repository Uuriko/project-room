// F-01: the guessed joining doors (/joining, /start, /docs/joining,
// /docs/start, /docs/onboarding) fell through to the generic 404 — a JSON
// body naming an API re-list for machine clients, an HTML page that never
// links /join for browsers. Contract (wave-2700 C01 lane-03 DESIGN.md):
// the exact door paths, their trailing-slash forms, their /room/ twins and
// the two siblings /onboarding + /invite answer GET/HEAD with a 302 to the
// real door (/join, or /room/join for the twins), Cache-Control: no-store,
// in every Accept mode. Everything else keeps today's behaviour — other
// methods, excluded guesses, /api/ contracts, and bare /ard.json (another
// owner's surface sharing the same fall-through).
//
// Harness follows tests/public-search-http.test.js, with an in-memory
// store (as in tests/account-access-requests.test.js) so the suite does
// not depend on file-backed WAL storage.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const store = new RoomStore(":memory:");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const BROWSER = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const FIVE_DOORS = ["/joining", "/start", "/docs/joining", "/docs/start", "/docs/onboarding"];

async function assertRedirect(origin, path, target, headers = {}) {
  const res = await fetch(`${origin}${path}`, { redirect: "manual", headers });
  await res.text();
  assert.equal(res.status, 302, `GET ${path} status`);
  assert.equal(res.headers.get("location"), target, `GET ${path} location`);
  assert.equal(res.headers.get("cache-control"), "no-store", `GET ${path} cache-control`);
}

test("T1: the five guessed doors redirect to /join in every Accept mode", async t => {
  const origin = await serve(t);
  for (const path of FIVE_DOORS) {
    await assertRedirect(origin, path, "/join");
    await assertRedirect(origin, path, "/join", BROWSER);
    await assertRedirect(origin, path, "/join", { accept: "application/json" });
  }
});

test("T2: trailing-slash forms and /room/ twins redirect, twins to /room/join", async t => {
  const origin = await serve(t);
  await assertRedirect(origin, "/joining/", "/join");
  await assertRedirect(origin, "/docs/onboarding/", "/join");
  for (const path of FIVE_DOORS) await assertRedirect(origin, `/room${path}`, "/room/join");
  await assertRedirect(origin, "/room/joining/", "/room/join");
});

test("T3: siblings /onboarding and /invite are covered; excluded guesses are not", async t => {
  const origin = await serve(t);
  await assertRedirect(origin, "/onboarding", "/join");
  await assertRedirect(origin, "/invite", "/join");
  await assertRedirect(origin, "/room/onboarding", "/room/join");
  await assertRedirect(origin, "/room/invite", "/room/join");
  for (const path of ["/signup", "/register", "/get-started", "/join-us", "/joiningg", "/starts", "/docs/join"]) {
    const res = await fetch(`${origin}${path}`, { redirect: "manual" });
    const body = await res.json();
    assert.equal(res.status, 404, `GET ${path} status`);
    assert.equal(res.headers.get("location"), null, `GET ${path} has no Location`);
    assert.equal(body.error.code, "not_found", `GET ${path} error code`);
  }
});

test("T4: following a guessed door lands on the real join page in one hop", async t => {
  const origin = await serve(t);
  for (const path of ["/joining", "/room/start"]) {
    const res = await fetch(`${origin}${path}`);
    const html = await res.text();
    assert.equal(res.status, 200, `GET ${path} followed status`);
    assert.match(html, /<title>Join Project Room<\/title>/, `GET ${path} followed is the join page`);
    assert.equal(res.url, `${origin}${path.startsWith("/room") ? "/room/join" : "/join"}`, `GET ${path} lands directly on the door`);
  }
});

test("T5: bare /ard.json is unchanged in both modes", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/ard.json`, { redirect: "manual" });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "not_found");
  assert.equal(body.status, "action_required");
  assert.match(body.hint, /do not guess ids/);
  assert.ok(JSON.stringify(body.next).includes("/api/public-work/tasks"), "generic next steps unchanged");
  const htmlRes = await fetch(`${origin}/ard.json`, { redirect: "manual", headers: BROWSER });
  const html = await htmlRes.text();
  assert.equal(htmlRes.status, 404);
  assert.equal(html, readFileSync(new URL("../404.html", import.meta.url), "utf8"), "HTML 404 body still byte-equal to 404.html");
});

test("T6: non-GET/HEAD methods keep today's JSON 404; HEAD redirects with an empty body", async t => {
  const origin = await serve(t);
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await fetch(`${origin}/joining`, { method, redirect: "manual" });
    const body = await res.json();
    assert.equal(res.status, 404, `${method} /joining status`);
    assert.equal(res.headers.get("location"), null, `${method} /joining has no Location`);
    assert.equal(body.error.code, "not_found");
  }
  const head = await fetch(`${origin}/joining`, { method: "HEAD", redirect: "manual" });
  assert.equal(head.status, 302);
  assert.equal(head.headers.get("location"), "/join");
  assert.equal(await head.text(), "");
});

test("T7: the query string is not carried over", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/start?ref=example`, { redirect: "manual" });
  await res.text();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/join");
});

test("T8: neighbours are unchanged — /join serves and /compare still 301s", async t => {
  const origin = await serve(t);
  const join = await fetch(`${origin}/join`, { redirect: "manual" });
  assert.equal(join.status, 200);
  assert.match(await join.text(), /<title>Join Project Room<\/title>/);
  const compare = await fetch(`${origin}/compare`, { redirect: "manual" });
  await compare.text();
  assert.equal(compare.status, 301);
  assert.equal(compare.headers.get("location"), "/compare/project-room-vs-slack");
});
