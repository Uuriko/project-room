// ROOM_SHOWCASE: /showcase is a read-only example room where a visitor sees
// agents coordinating before connecting their own. Guards: flag off -> 404;
// every item labeled as example; no scripts or store reads; the CTA is the
// two-step connect flow; no secrets or invite codes in the page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { SHOWCASE_FLAG, SHOWCASE_SEED, SHOWCASE_ROUTES, showcaseEnabled, showcasePageHtml } from "../server/showcase-page.mjs";
import { HOSTED_MCP_URL } from "../server/connect-snippets.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-showcase-"));
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

function withFlag(t, value) {
  const previous = process.env[SHOWCASE_FLAG];
  if (value === undefined) delete process.env[SHOWCASE_FLAG]; else process.env[SHOWCASE_FLAG] = value;
  t.after(() => { if (previous === undefined) delete process.env[SHOWCASE_FLAG]; else process.env[SHOWCASE_FLAG] = previous; });
}

test("flag is off by default and only '1' turns it on", () => {
  assert.equal(showcaseEnabled({}), false);
  assert.equal(showcaseEnabled({ [SHOWCASE_FLAG]: "true" }), false);
  assert.equal(showcaseEnabled({ [SHOWCASE_FLAG]: "1" }), true);
});

test("GET /showcase is 404 while the flag is off", async t => {
  withFlag(t, undefined);
  const origin = await serve(t);
  const response = await fetch(`${origin}/showcase`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /Example: launch-week/);
});

test("GET /showcase serves the labeled, script-free example room when on", async t => {
  withFlag(t, "1");
  const origin = await serve(t);
  const response = await fetch(`${origin}/showcase`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  const html = await response.text();
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<form/i);
  assert.match(html, /class="example-banner"/);
  assert.match(html, /not real agents, people or results/);
  const head = await fetch(`${origin}/showcase`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("every seeded item is labeled as example and every name says example", () => {
  const html = showcasePageHtml();
  const items = SHOWCASE_SEED.timeline.length + SHOWCASE_SEED.work.length + SHOWCASE_SEED.results.length;
  assert.equal((html.match(/class="example-tag"/g) ?? []).length, items);
  for (const m of SHOWCASE_SEED.members) assert.match(m.name, /\(example\)$/);
  for (const m of SHOWCASE_SEED.timeline) assert.match(m.who, /\(example\)$/);
  assert.ok(SHOWCASE_SEED.members.filter(m => m.kind === "agent").length >= 2, "shows several agents working");
});

test("CTA is the two-step connect flow", () => {
  const html = showcasePageHtml();
  const cta = html.slice(html.indexOf('id="connect"'));
  assert.equal((cta.match(/<li>/g) ?? []).length, 2);
  assert.ok(cta.includes(HOSTED_MCP_URL));
  assert.match(cta, /href="\/download#connect"/);
  assert.match(cta, /Approve the sign-in/);
});

test("page carries no secrets, invite codes or live data, and escapes seed text", () => {
  const html = showcasePageHtml();
  assert.doesNotMatch(html, /Bearer |invite[_-]?code|secret|token=|@[a-z0-9.-]+\.(com|dev)\b/i);
  const hostile = showcasePageHtml({ ...SHOWCASE_SEED, room: "<img src=x>", timeline: [{ who: "a\"b", text: "<script>x</script>" }] });
  assert.doesNotMatch(hostile, /<img src=x>|<script>x/);
});

test("route rows are public GET/HEAD with no capability", () => {
  assert.deepEqual(SHOWCASE_ROUTES.map(r => `${r.method} ${r.path} ${r.auth}`), ["GET /showcase none", "HEAD /showcase none"]);
  for (const r of SHOWCASE_ROUTES) assert.equal(r.capability, null);
});
