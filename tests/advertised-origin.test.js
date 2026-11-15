// Self-hosted public-page origin: a fresh instance advertises its own origin in
// the sitemap, the canonical Link headers and the canonical/OG/JSON-LD tags of
// its public pages; hosted output stays byte-identical to the authored bytes;
// invitation URLs keep using the instance origin exactly as before.
//
// Out of scope here (Codex, PR #6192): discovery documents (llms.txt,
// llms-full.txt, agent.json, agent-card.json, ard.json, robots.txt, the MCP
// server card, the skills index). Nothing below asserts on those bytes.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ROOM_ORIGIN } from "../server/agent-discovery.mjs";
import { reviewedPublicSearchPaths } from "../server/public-search.mjs";
import { advertisedText, advertisedHtml, advertisedOrigin, isHostedOrigin } from "../server/advertised-origin.mjs";

const HOSTED_HOST = new URL(ROOM_ORIGIN).host;
const MERGED_AT = "2026-10-05T00:00:00.000Z";
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Tags a crawler reads. Preload/stylesheet/icon/manifest links name assets, not pages.
const discoveryTags = html => (html.match(/<(?:link|meta)\b[^>]*>|<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi) ?? [])
  .filter(tag => !/rel="(?:preload|stylesheet|icon|manifest)"/i.test(tag)).join("\n");

async function start(t, origin) {
  const directory = mkdtempSync(join(tmpdir(), "advertised-origin-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("gallery-room"));
  const ownerKey = store.issueAccessKey("gallery-room", "owner");
  store.command(ownerKey, "gallery-room", { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set("gallery-room", {
    id: "settled-claim", title: "Settled for the origin test", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: MERGED_AT }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/42", outcome: "merged", syncedAt: MERGED_AT },
    blobs: [], updatedAt: MERGED_AT,
  });
  const server = createRoomServer({ store, ...(origin ? { origin } : {}) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  // Node's fetch cannot set Host; the server pins Host to its configured origin.
  const send = (method, path, { host = `127.0.0.1:${port}`, token, body } = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { host, accept: "text/html, application/json, application/xml, */*", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
  const receipts = JSON.parse((await send("GET", "/api/public/receipts", { host: origin ? new URL(origin).host : `127.0.0.1:${port}` })).text).receipts;
  return { port, send, ownerKey, receiptId: receipts.find(r => r.title === "Settled for the origin test")?.id };
}

test("helper: hosted or absent origin is a strict no-op (same string)", () => {
  const text = `see ${ROOM_ORIGIN}/mcp`;
  const html = `<link rel="canonical" href="${ROOM_ORIGIN}/about"><a href="${ROOM_ORIGIN}/x">x</a>`;
  for (const origin of [undefined, null, "", ROOM_ORIGIN, `${ROOM_ORIGIN}/`]) {
    assert.equal(isHostedOrigin(origin), true);
    assert.equal(advertisedOrigin(origin), ROOM_ORIGIN);
    assert.equal(advertisedText(text, origin), text);
    assert.equal(advertisedHtml(html, origin), html);
  }
  assert.equal(isHostedOrigin("https://room.example"), false);
  assert.equal(advertisedText(text, "https://room.example/"), "see https://room.example/mcp");
});

test("helper: HTML rewrites discovery tags only; body links and protocol text stay as authored", () => {
  const html = [
    `<link rel="canonical" href="${ROOM_ORIGIN}/about">`,
    `<link rel="alternate" href="${ROOM_ORIGIN}/about.json">`,
    `<link rel="stylesheet" href="${ROOM_ORIGIN}/src/styles.css">`,
    `<meta property="og:url" content="${ROOM_ORIGIN}/about">`,
    `<script type="application/ld+json">{"url":"${ROOM_ORIGIN}/about"}</script>`,
    `<a href="${ROOM_ORIGIN}/receipts/sample">sample</a>`,
    `<p>${ROOM_ORIGIN}/extensions/work-receipt/v1</p>`,
  ].join("\n");
  const out = advertisedHtml(html, "https://room.example");
  assert.ok(out.includes(`<link rel="canonical" href="https://room.example/about">`));
  assert.ok(out.includes(`<link rel="alternate" href="https://room.example/about.json">`));
  assert.ok(out.includes(`<meta property="og:url" content="https://room.example/about">`));
  assert.ok(out.includes(`{"url":"https://room.example/about"}`));
  assert.ok(out.includes(`<link rel="stylesheet" href="${ROOM_ORIGIN}/src/styles.css">`), "asset links are not page identity");
  assert.ok(out.includes(`<a href="${ROOM_ORIGIN}/receipts/sample">`), "body links are untouched");
  assert.ok(out.includes(`<p>${ROOM_ORIGIN}/extensions/work-receipt/v1</p>`), "protocol identifiers in body text are untouched");
});

for (const [label, origin] of [["loopback default", null], ["configured https origin", "https://room.selfhost.example"]]) {
  test(`self-hosted (${label}): every reviewed public page, the sitemap and receipt pages name the instance origin`, async t => {
    const server = await start(t, origin);
    const own = origin ?? `http://127.0.0.1:${server.port}`;
    const host = new URL(own).host;
    const counts = {};
    const paths = [...reviewedPublicSearchPaths, "/sitemap.xml", `/receipts/${server.receiptId}`];
    assert.ok(server.receiptId, "seeded room receipt is published");
    assert.ok(paths.length >= 20, `reviewed path set is complete (${paths.length})`);
    assert.ok(reviewedPublicSearchPaths.filter(path => !path.startsWith("/docs/agents")).length >= 8, "static pages, compare pages and /receipts are present");
    const absent = [];
    for (const path of paths) {
      const res = await server.send("GET", path, { host });
      // Generated pages (docs/agents/*) are absent from a source checkout: the designed package state,
      // checked on the packaged Worker instead (cloudflare/public-search.check.mjs). Never a pass here.
      if (res.status === 404 && path.startsWith("/docs/agents")) { absent.push(path); continue; }
      assert.equal(res.status, 200, `${path} status`);
      const checked = path === "/sitemap.xml" ? res.text : discoveryTags(res.text);
      counts[path] = [checked.split(ROOM_ORIGIN).length - 1, String(res.headers.link ?? "").split(ROOM_ORIGIN).length - 1];
      assert.equal(counts[path][0], 0, `${path} discovery tags/sitemap still name ${ROOM_ORIGIN}`);
      assert.equal(counts[path][1], 0, `${path} Link header names the hosted origin`);
      assert.ok(String(res.headers.link ?? "").includes(`<${own}${path}>; rel="canonical"`), `${path} canonical Link header names this instance: ${res.headers.link}`);
    }
    // Per-path residual hosted-origin counts [discovery tags or sitemap, Link header]; all zero.
    console.log(`advertised-origin(${label}): ${Object.keys(counts).length} of ${paths.length} paths served, residual hosted-origin counts`, JSON.stringify(counts), `NOT-RUN (generated, absent in source tree): ${JSON.stringify(absent)}`);
    assert.ok(absent.every(path => path.startsWith("/docs/agents")));
    const home = (await server.send("GET", "/", { host })).text;
    assert.match(home, new RegExp(`<link rel="canonical" href="${escapeRe(own)}/">`));
    assert.match(home, new RegExp(`property="og:url" content="${escapeRe(own)}/"`));
    assert.match(home, new RegExp(`property="og:image" content="${escapeRe(own)}/og/home\\.png"`));
    const about = (await server.send("GET", "/about", { host })).text;
    assert.match(about, new RegExp(`<link rel="canonical" href="${escapeRe(own)}/about">`));
    const sitemap = (await server.send("GET", "/sitemap.xml", { host })).text;
    assert.ok(sitemap.includes(`<loc>${own}/</loc>`) && sitemap.includes(`<loc>${own}/offers</loc>`) && sitemap.includes(`<loc>${own}/receipts</loc>`));
    assert.ok(sitemap.includes(`<loc>${own}/receipts/${server.receiptId}</loc>`), "published receipt is in the sitemap at this origin");
    const root = await server.send("GET", "/", { host });
    assert.ok(String(root.headers.link).includes(`<${own}/>; rel="canonical"`), root.headers.link);
    // Body links to hosted fixtures stay as authored (not a blanket rewrite).
    assert.ok(home.includes(ROOM_ORIGIN), "front-door body still carries its authored hosted links (owner: front-door copy, not this slice)");
  });
}

test("hosted mode: public pages, sitemap and Link headers equal the authored hosted bytes", async t => {
  const server = await start(t, ROOM_ORIGIN);
  const loopback = await start(t, null);
  const own = `http://127.0.0.1:${loopback.port}`;
  let compared = 0;
  for (const path of reviewedPublicSearchPaths) {
    const hosted = await server.send("GET", path, { host: HOSTED_HOST });
    const twin = await loopback.send("GET", path, { host: `127.0.0.1:${loopback.port}` });
    assert.equal(hosted.status, twin.status, `${path} status`);
    if (hosted.status !== 200) continue;
    // Hosted equals the self-hosted twin mapped back: the two differ by the origin and nothing else.
    assert.equal(hosted.text, twin.text.split(own).join(ROOM_ORIGIN), `${path}: differs by more than the origin`);
    // Compare the canonical entry only: the unchanged discovery links are relative on loopback and absolute on the hosted Host.
    const canonical = headers => String(headers.link).split(/,\s*(?=<)/).find(part => /rel="canonical"/.test(part));
    assert.ok(canonical(hosted.headers), `${path}: hosted canonical Link present`);
    assert.equal(canonical(hosted.headers), canonical(twin.headers).split(own).join(ROOM_ORIGIN), `${path}: canonical Link differs by more than the origin`);
    compared += 1;
  }
  assert.ok(compared >= 8, `compared ${compared} pages`);
  const sitemap = await server.send("GET", "/sitemap.xml", { host: HOSTED_HOST });
  assert.ok(sitemap.text.includes(`<loc>${ROOM_ORIGIN}/</loc>`));
  assert.ok(String(sitemap.headers.link).includes(`<${ROOM_ORIGIN}/sitemap.xml>; rel="canonical"`));
  const home = await server.send("GET", "/", { host: HOSTED_HOST });
  assert.match(home.text, /<link rel="canonical" href="https:\/\/room\.trydemigod\.com\/">/);
});

// Invitation URL no-regression: the rewrite must never touch invite/connect URLs.
// They name the serving origin (expectedOrigin()) exactly as before this change,
// in hosted, configured and loopback modes, in the create response and in `next`.
for (const [label, origin] of [["hosted", ROOM_ORIGIN], ["configured self-hosted", "https://room.selfhost.example"], ["loopback", null]]) {
  test(`invitation URLs keep the serving origin (${label})`, async t => {
    const server = await start(t, origin);
    const own = origin ?? `http://127.0.0.1:${server.port}`;
    const host = new URL(own).host;
    const minted = await server.send("POST", "/api/rooms/gallery-room/agent-invites", { host, token: server.ownerKey, body: { profile: "contribute", expiresInMinutes: 30 } });
    assert.equal(minted.status, 201, minted.text);
    const created = JSON.parse(minted.text);
    assert.equal(created.url, `${own}/a/${created.code}`, "invite URL is the serving origin + /a/<code>");
    assert.equal(created.next[0].url, created.url);
    assert.equal(minted.text.includes(ROOM_ORIGIN), own === ROOM_ORIGIN, "the create response names the hosted origin only when it is the serving origin");
    const joinPage = await server.send("GET", `/join/${created.code}`, { host });
    assert.equal(joinPage.status, 200, joinPage.text.slice(0, 200));
    assert.ok(joinPage.text.includes(own), "the join steps name the serving origin");
    // The public-page rewrite does not touch private API bodies.
    const listed = await server.send("GET", "/api/rooms/gallery-room/agent-invites", { host, token: server.ownerKey });
    assert.equal(listed.status, 200, listed.text);
    if (own !== ROOM_ORIGIN) assert.equal(listed.text.includes(ROOM_ORIGIN), false, "no hosted origin appears in a self-hosted invite list");
  });
}

test("self-hosted: repeated requests for a static page return identical advertised bytes (memoised rewrite)", async t => {
  const origin = "https://room.example";
  const { send } = await start(t, origin);
  const host = new URL(origin).host;
  for (const path of ["/", "/about"]) {
    const first = await send("GET", path, { host });
    const second = await send("GET", path, { host });
    assert.equal(first.status, 200, path);
    assert.equal(second.text, first.text, `${path} must be byte-identical across requests`);
    assert.ok(!discoveryTags(first.text).includes(HOSTED_HOST), `${path} discovery tags must name the instance origin`);
  }
});
