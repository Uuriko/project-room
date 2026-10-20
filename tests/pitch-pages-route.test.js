import { test } from "node:test";
import assert from "node:assert/strict";
import { forPage, vsPage, indexPage, startersPage, startersJson, PITCH_PAGE_ROUTES } from "../server/routes/pitch-pages.mjs";
import { FOR_AGENTS, VS_COMPETITORS, PROMISE } from "../server/pitch-pages-data.mjs";
import { STARTERS } from "../server/starters-data.mjs";

test("every /for and /vs slug renders a script-free page carrying the promise and the setup paste", () => {
  for (const slug of Object.keys(FOR_AGENTS)) {
    const html = forPage(slug);
    assert.match(html, /<h1>Project Room for/);
    assert.ok(html.includes(PROMISE.slice(0, 40)));
    assert.ok(html.includes("/.well-known/agent-skills/connect/SKILL.md"));
    assert.doesNotMatch(html, /<script/i);
  }
  for (const slug of Object.keys(VS_COMPETITORS)) {
    const html = vsPage(slug);
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /<script|credit card|free trial/i);
  }
});

test("unknown and prototype slugs render nothing", () => {
  for (const slug of ["nope", "constructor", "__proto__", "toString"]) {
    assert.equal(forPage(slug), null);
    assert.equal(vsPage(slug), null);
  }
});

test("index pages link every page", () => {
  for (const slug of Object.keys(FOR_AGENTS)) assert.ok(indexPage("for").includes(`/for/${slug}"`));
  for (const slug of Object.keys(VS_COMPETITORS)) assert.ok(indexPage("vs").includes(`/vs/${slug}"`));
});

test("starters: unique ids, every prompt in the HTML, JSON carries the schema", () => {
  const ids = STARTERS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(STARTERS.length >= 10);
  const html = startersPage();
  for (const s of STARTERS) assert.ok(html.includes(`id="${s.id}"`));
  assert.equal(startersJson().schema, "project-room-starters/1");
  assert.equal(startersJson().starters.length, STARTERS.length);
});

test("pitch routes are public GET/HEAD pairs with parity notes", () => {
  assert.equal(PITCH_PAGE_ROUTES.length, 12);
  for (const row of PITCH_PAGE_ROUTES) {
    assert.equal(row.auth, "none");
    assert.ok(["GET", "HEAD"].includes(row.method));
    assert.match(row.parity, /^exempt:/);
  }
});

test("handler answers 404 HTML for unknown slugs and omits the body on HEAD", async () => {
  const row = PITCH_PAGE_ROUTES.find(r => r.id === "vs-page-head");
  const out = {};
  const ctx = { rate() {}, remoteAddress: "x", params: { slug: "leverage" }, req: { method: "HEAD" }, expectedOrigin: () => "https://room.trydemigod.com",
    res: { setHeader() {}, writeHead(s, h) { out.status = s; out.headers = h; }, end(b) { out.body = b; } } };
  await row.handler(ctx);
  assert.equal(out.status, 200);
  assert.equal(out.body, undefined);
  ctx.params.slug = "nope";
  await row.handler(ctx);
  assert.equal(out.status, 404);
});
