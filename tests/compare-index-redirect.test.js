// /compare had no page and returned 404 on both doors; the comparison pages
// still said "invite-only pilot" after the public lobby opened.
// Contract: a bare /compare 301s to the footer's comparison on Node and at
// the edge (with the getdasha /room prefix kept), and no comparison page
// claims an invite-only pilot.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparisonSlugs, compareIndexRedirect, COMPARE_INDEX_TARGET } from "../server/public-search.mjs";
import { classifyEdgePath, edgePublicResponse } from "../cloudflare/edge-public.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

test("compareIndexRedirect covers bare /compare forms only", () => {
  assert.equal(compareIndexRedirect("/compare"), COMPARE_INDEX_TARGET);
  assert.equal(compareIndexRedirect("/compare/"), COMPARE_INDEX_TARGET);
  assert.equal(compareIndexRedirect("/room/compare"), `/room${COMPARE_INDEX_TARGET}`);
  assert.equal(compareIndexRedirect("/compare/project-room-vs-slack"), null);
  assert.equal(compareIndexRedirect("/compares"), null);
  assert.ok(comparisonSlugs.includes(COMPARE_INDEX_TARGET.slice("/compare/".length)), "target is a real comparison page");
});

test("edge answers /compare with a 301 and refuses writes", async () => {
  assert.equal(classifyEdgePath("/compare"), "compare-index");
  const url = new URL("https://room.trydemigod.com/compare");
  const get = await edgePublicResponse(new Request(url), {}, url);
  assert.equal(get.status, 301);
  assert.equal(get.headers.get("location"), COMPARE_INDEX_TARGET);
  const prefixed = new URL("https://www.getdasha.com/room/compare/");
  const room = await edgePublicResponse(new Request(prefixed), {}, prefixed);
  assert.equal(room.headers.get("location"), `/room${COMPARE_INDEX_TARGET}`);
  const post = await edgePublicResponse(new Request(url, { method: "POST" }), {}, url);
  assert.equal(post.status, 405);
});

test("Node server answers /compare with a 301", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-compare-index-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/compare", "/compare/"]) {
    const response = await fetch(origin + path, { redirect: "manual" });
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("location"), COMPARE_INDEX_TARGET);
  }
});

test("no comparison page claims an invite-only pilot; each points at the public lobby", () => {
  for (const slug of comparisonSlugs) {
    const html = readFileSync(new URL(`../compare/${slug}.html`, import.meta.url), "utf8");
    assert.doesNotMatch(html, /invite-only/i, slug);
    assert.match(html, /href="\/r\/project-room-lobby"/, slug);
  }
});
