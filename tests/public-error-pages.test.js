// HD-08 — error pages on the human door. A browser on a public (non-API) path
// must get a plain-language HTML error page: what happened, what to do next,
// never the JSON envelope, never machine codes, never "Unknown error".
// Machine/API clients keep the JSON envelope.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { publicErrorHtml } from "../deploy/public-search.mjs";

const BROWSER = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const MACHINE = { Accept: "application/json" };

async function serve(t, { breakDb = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-error-pages-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  // Break the database AFTER server creation (creation itself reads the db):
  // every later store.db access throws a plain Error, which storageFailure
  // passes through untouched (it only types real sqlite unavailability), so
  // the pipeline surfaces a genuine untyped 500.
  let realDb = null;
  if (breakDb) {
    realDb = store.db;
    const blowup = () => { throw new Error("simulated storage blowup"); };
    store.db = new Proxy(realDb, { get: blowup, set: blowup });
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (realDb) store.db = realDb;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function assertHumanPage(html, { status, operationId = false } = {}) {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<h1>[^<]+<\/h1>/);
  assert.match(html, /href="\/"/, "links home as the way forward");
  assert.doesNotMatch(html, /Unknown error/i);
  assert.doesNotMatch(html, /internal_error/);
  assert.doesNotMatch(html, /method_not_allowed/);
  assert.doesNotMatch(html, /^\s*\{/, "not the JSON envelope");
  if (operationId) assert.match(html, /op_[A-Za-z0-9_-]+/, "5xx quotes the request code for support");
}

test("publicErrorHtml speaks plain language for every status class", () => {
  const seen = new Map([
    [400, /didn(?:'|&#39;)t make sense|understand/i],
    [401, /sign in/i],
    [403, /don't have access|not allowed/i],
    [404, /Page not found/],
    [405, /doesn(?:'|&#39;)t accept/i],
    [409, /conflict/i],
    [413, /too big/i],
    [415, /format/i],
    [422, /isn(?:'|&#39;)t quite right/i],
    [429, /too many tries|slow down/i],
    [500, /went wrong/i],
    [503, /trouble|unavailable/i],
  ]);
  for (const [status, plain] of seen) {
    const html = publicErrorHtml({ status, operationId: "op_test123" });
    assertHumanPage(html, { status, operationId: status >= 500 });
    assert.match(html, plain, `status ${status} says what happened in plain language`);
    assert.match(html, /<title>[^<]+<\/title>/);
  }
  const teapot = publicErrorHtml({ status: 418, operationId: "op_x" });
  assertHumanPage(teapot, { status: 418 });
  assert.doesNotMatch(teapot, /op_x/, "4xx pages do not quote the request code");
  assert.doesNotMatch(publicErrorHtml({ status: 500 }), /<script/i);
});

test("a browser hitting a 500 on a public path gets the HTML error page", async t => {
  const origin = await serve(t, { breakDb: true });
  const page = await fetch(`${origin}/r/some-room`, { headers: BROWSER });
  assert.equal(page.status, 500);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);
  const html = await page.text();
  assertHumanPage(html, { status: 500, operationId: true });
  assert.match(html, /try again/i, "says what to do next");
});

test("a browser posting to a page route gets an HTML 405, not JSON", async t => {
  const origin = await serve(t);
  const page = await fetch(`${origin}/join/some-code`, { method: "POST", headers: BROWSER });
  assert.equal(page.status, 405);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assertHumanPage(await page.text(), { status: 405 });
});

test("machine clients and API paths keep the JSON envelope", async t => {
  const origin = await serve(t, { breakDb: true });
  const api = await fetch(`${origin}/r/some-room`, { headers: MACHINE });
  assert.equal(api.status, 500);
  assert.match(api.headers.get("content-type") ?? "", /application\/json/);
  const body = await api.json();
  assert.equal(body.error.code, "internal_error");
  const form = await fetch(`${origin}/join/some-code`, { method: "POST", headers: MACHINE });
  assert.equal(form.status, 405);
  assert.match(form.headers.get("content-type") ?? "", /application\/json/);
});

test("explicit .json twins keep JSON even for browsers", async t => {
  const origin = await serve(t, { breakDb: true });
  const twin = await fetch(`${origin}/r/some-room.json`, { headers: BROWSER });
  assert.equal(twin.status, 500);
  assert.match(twin.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await twin.json()).error.code, "internal_error");
});
