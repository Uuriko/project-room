// DOOR-LINKS-1: human links on / and /join stay same-host (or allow-listed).
// Fails on main (finds /llms.txt CTAs and third-host door links); passes after the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function externalAllowed(href) {
  if (href.startsWith("mailto:")) return href.startsWith("mailto:");
  try {
    const u = new URL(href);
    if (u.hostname === "github.com" || u.hostname.endsWith(".github.com")) return true;
    return false;
  } catch {
    return false;
  }
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-first-run-links-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin };
}

function anchors(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(re)) out.push(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function assertSameHostOrAllowlisted(path, hrefs, origin) {
  const bad = [];
  for (const href of hrefs) {
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    if (href.startsWith("/") || href.startsWith("{{")) continue;
    if (href.startsWith("?") || href.startsWith("./") || href.startsWith("../")) continue;
    if (externalAllowed(href)) continue;
    if (href.startsWith(origin)) continue;
    bad.push(href);
  }
  assert.deepEqual(bad, [], `${path} has off-host links:\n${bad.join("\n")}`);
}

test("sign-in page: Join guide and Connect your agent go to /docs/agents, Human door to /room", async t => {
  const { origin } = await serve(t);
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /href="\/docs\/agents">Join guide</);
  assert.match(html, /href="\/docs\/agents">Connect your agent</);
  assert.match(html, /href="\/room">Human door</);
  assert.doesNotMatch(html, /href="\/llms\.txt">Join guide</);
  assert.doesNotMatch(html, /href="\/llms\.txt">Connect your agent</);
  assert.doesNotMatch(html, /www\.trydemigod\.com\/room/);
  assert.match(html, /rel="help"[^>]*href="\/llms\.txt"|href="\/llms\.txt"[^>]*rel="help"/);
  assertSameHostOrAllowlisted("/", anchors(html), origin);
});

test("join page: What is Project Room? is same-host /room", async t => {
  const { origin } = await serve(t);
  for (const path of ["/join", "/join/RM-EXAMPLE", "/room/join", "/room/join/RM-EXAMPLE"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.doesNotMatch(html, /www\.getdasha\.com\/room/);
    assert.doesNotMatch(html, /www\.trydemigod\.com\/room/);
    assert.match(html, /What is Project Room\?/, path);
    assert.match(html, /href="\/(room\/)?room">What is Project Room\?</, path);
    assertSameHostOrAllowlisted(path, anchors(html), origin);
  }
});
