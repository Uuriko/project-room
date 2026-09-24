// Room-side web fetch (RC-2026-09-23-102).
//
// Unit tests for the pure pieces (URL validation, SSRF ranges, markdown,
// metadata, highlights, cache keys) plus HTTP tests against a real server:
// positive fetch via an in-process local HTTP page server with the
// env-gated loopback allowance (WEB_FETCH_ALLOW_LOOPBACK=1), cache
// hit/miss + age_ms, highlights ordering, guest 403, rate-limit 429,
// invalid URL 400, redirect-to-private blocked_host, unsupported content,
// fetch failure. No external network anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import {
  normalizeUrl, ipLiteralBlocked, htmlToMarkdown, extractMetadata,
  extractHighlights, cacheKeyFor, assertFetchableUrl,
  WebFetchError, WebFetch, webFetchSchema, webFetchContract, migrateWebFetchLogColumns,
} from "../server/web-fetch.mjs";

// The loopback allowance is read dynamically, so strict-mode tests can
// unset it around individual calls while the HTTP suite keeps it set.
const withEnv = (value, fn) => {
  const previous = process.env.WEB_FETCH_ALLOW_LOOPBACK;
  try {
    if (value === undefined) delete process.env.WEB_FETCH_ALLOW_LOOPBACK;
    else process.env.WEB_FETCH_ALLOW_LOOPBACK = value;
    return fn();
  } finally {
    if (previous === undefined) delete process.env.WEB_FETCH_ALLOW_LOOPBACK;
    else process.env.WEB_FETCH_ALLOW_LOOPBACK = previous;
  }
};

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------
test("normalizeUrl accepts http/https and normalizes", () => {
  assert.equal(normalizeUrl("http://example.com/a"), "http://example.com/a");
  assert.equal(normalizeUrl("https://example.com:443/a#frag"), "https://example.com/a");
  assert.equal(normalizeUrl("HTTP://EXAMPLE.COM/A"), "http://example.com/A");
});

test("normalizeUrl rejects non-http, credentials, ports, garbage", () => {
  for (const bad of ["ftp://example.com/", "gopher://example.com/", "http://user:pass@example.com/",
    "http://example.com:8080/", "https://example.com:80/", "not a url", "", "http://"]) {
    assert.throws(() => normalizeUrl(bad), error =>
      error instanceof WebFetchError && error.status === 400 && error.code === "invalid_url", bad);
  }
});

// ---------------------------------------------------------------------------
// SSRF ranges (strict: allowance unset)
// ---------------------------------------------------------------------------
test("ipLiteralBlocked refuses private/loopback/link-local/multicast/reserved/CGNAT", () => withEnv(undefined, () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.0.9", "172.31.255.255",
    "192.168.0.1", "169.254.169.254", "224.0.0.1", "0.0.0.0", "100.64.0.1",
    "192.0.2.1", "198.51.100.7", "203.0.113.9",
    "::1", "::", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(ipLiteralBlocked(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2001:4860:4860::8888"]) {
    assert.equal(ipLiteralBlocked(ip), false, ip);
  }
  assert.equal(ipLiteralBlocked("example.com"), false);
}));

test("loopback allowance opens 127/8 and ::1 only", () => withEnv("1", () => {
  assert.equal(ipLiteralBlocked("127.0.0.1"), false);
  assert.equal(ipLiteralBlocked("::1"), false);
  assert.equal(ipLiteralBlocked("::ffff:127.0.0.1"), false);
  for (const ip of ["10.0.0.1", "192.168.1.1", "169.254.169.254", "8.8.8.8"]) {
    assert.equal(ipLiteralBlocked(ip), ip === "8.8.8.8" ? false : true, ip);
  }
}));

test("assertFetchableUrl blocks loopback/private even before any connection", async () => {
  await withEnv(undefined, async () => {
    for (const url of ["http://127.0.0.1/", "http://10.0.0.1:80/", "http://[::1]/", "http://169.254.169.254/latest"]) {
      await assert.rejects(assertFetchableUrl(url), error =>
        error instanceof WebFetchError && error.status === 403 && error.code === "blocked_host", url);
    }
  });
});

// ---------------------------------------------------------------------------
// HTML -> markdown, metadata, highlights
// ---------------------------------------------------------------------------
const SYNTH_HTML = `<!doctype html><html lang="en"><head><title>Test Page</title>
<meta name="description" content="A test page for fetching">
</head><body>
<nav>skip this nav</nav>
<script>var evil = 1;</script>
<style>.x { color: red; }</style>
<h1>Hello World</h1>
<p>This is a <a href="/about">relative link</a> and an <a href="https://other.example/x">external link</a>.</p>
<ul><li>one</li><li>two</li></ul>
<blockquote>quoted text</blockquote>
</body></html>`;

test("htmlToMarkdown converts headings, links, lists and strips chrome", () => {
  const md = htmlToMarkdown(SYNTH_HTML, "http://127.0.0.1:9999/base/");
  assert.match(md, /^# Hello World/m);
  assert.ok(md.includes("[relative link](http://127.0.0.1:9999/about)"), md);
  assert.ok(md.includes("[external link](https://other.example/x)"), md);
  assert.ok(md.includes("- one") && md.includes("- two"), md);
  assert.ok(md.includes("> quoted text"), md);
  assert.ok(!md.includes("skip this nav"), "nav stripped");
  assert.ok(!md.includes("evil"), "script stripped");
  assert.ok(!md.includes("color: red"), "style stripped");
});

test("htmlToMarkdown degrades non-web link schemes to text", () => {
  const md = htmlToMarkdown('<p><a href="javascript:alert(1)">click</a> <a href="mailto:a@b.c">mail</a></p>', "http://x.example/");
  assert.ok(md.includes("click") && md.includes("mail"), md);
  assert.ok(!md.includes("javascript:"), md);
});

test("extractMetadata reads title, description, language, headings", () => {
  const meta = extractMetadata(SYNTH_HTML);
  assert.equal(meta.title, "Test Page");
  assert.equal(meta.description, "A test page for fetching");
  assert.equal(meta.language, "en");
  assert.deepEqual(meta.headings, ["Hello World"]);
});

test("extractMetadata headings skip nav/footer chrome", () => {
  const meta = extractMetadata(`<html><body><nav><h2>Nav heading</h2></nav><footer><h3>Foot heading</h3></footer><h1>Real</h1></body></html>`);
  assert.deepEqual(meta.headings, ["Real"]);
});

test("extractHighlights returns top passages in page order with [heading] prefix", () => {
  const md = `# Alpha\nThe quick brown fox jumps over the lazy dog.\n# Beta\nCompletely unrelated text about nothing.\n# Gamma\nAnother mention of the quick fox here.`;
  const hits = extractHighlights(md, "quick fox", 5);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].startsWith("[Alpha] "), hits[0]);
  assert.ok(hits[1].startsWith("[Gamma] "), hits[1]);
  assert.ok(hits[0].includes("quick brown fox"), hits[0]);
});

test("extractHighlights respects maxPassages and returns [] on no match", () => {
  const md = `# One\napple apple apple\n# Two\napple\n# Three\napple`;
  assert.equal(extractHighlights(md, "apple", 2).length, 2);
  assert.deepEqual(extractHighlights(md, "zebra"), []);
  assert.deepEqual(extractHighlights("", "apple"), []);
});

test("extractHighlights drops heading-only sections", () => {
  const md = `# Quick Fox\n# Other\nSome body text without the terms.`;
  assert.deepEqual(extractHighlights(md, "quick fox"), []);
});

test("cacheKeyFor is deterministic and URL-scoped", () => {
  const a = cacheKeyFor("http://example.com/a"), b = cacheKeyFor("http://example.com/a");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, cacheKeyFor("http://example.com/b"));
});

test("noteRoomFetch records per-room cache visibility idempotently", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(webFetchSchema);
  db.exec("CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO rooms(id) VALUES('r1'),('r2')").run();
  const svc = new WebFetch({ db, now: () => 1_000_000 });
  svc.noteRoomFetch("k1", "r1", 1_000_000);
  svc.noteRoomFetch("k1", "r1", 1_000_001); // idempotent re-fetch
  svc.noteRoomFetch("k1", "r2", 1_000_002); // same URL, other room
  const rows = db.prepare("SELECT cache_key, room_id FROM web_fetch_cache_rooms ORDER BY room_id").all()
    .map(r => ({ cache_key: r.cache_key, room_id: r.room_id }));
  assert.deepEqual(rows, [
    { cache_key: "k1", room_id: "r1" },
    { cache_key: "k1", room_id: "r2" },
  ]);
});

test("webFetchContract exposes the documented surface", () => {
  const contract = webFetchContract();
  assert.equal(contract.status, "live");
  assert.equal(contract.auth, "owner_and_full_members");
  assert.deepEqual(contract.formats, ["markdown", "highlights"]);
  assert.ok(contract.typedErrors.includes("blocked_host"));
  assert.ok(contract.typedErrors.includes("rate_limited"));
});

// ---------------------------------------------------------------------------
// HTTP suite: real server, in-process page server, loopback allowance on.
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html><html lang="en"><head><title>Local Page</title>
<meta name="description" content="Served by the test page server"></head><body>
<h1>Section One</h1><p>The quick brown fox is the star of section one.</p>
<h2>Section Two</h2><p>Nothing about animals here, just filler words.</p>
</body></html>`;

async function serve(t) {
  process.env.WEB_FETCH_ALLOW_LOOPBACK = "1";
  const directory = mkdtempSync(join(tmpdir(), "room-web-fetch-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const command = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  command(T.MEMBER_ADDED, { memberId: "member", displayName: "Member", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  store.bindHumanAccount("commons", "member", "account-member");
  const memberKey = store.issueAccessKey("commons", "member");
  const page = createServer((req, res) => {
    if (req.url === "/redir") {
      res.writeHead(302, { Location: "/page" }); res.end(); return;
    }
    if (req.url === "/redir-private") {
      res.writeHead(302, { Location: "http://10.0.0.1/" }); res.end(); return;
    }
    if (req.url === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return;
    }
    if (req.url === "/err") {
      res.writeHead(500, { "Content-Type": "text/plain" }); res.end("boom"); return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  await new Promise(resolve => page.listen(0, "127.0.0.1", resolve));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => page.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.WEB_FETCH_ALLOW_LOOPBACK;
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pageOrigin = `http://127.0.0.1:${page.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, ownerKey, memberKey, pageOrigin };
}

async function redeemGuest(request, ownerKey, store, name = "Synapse") {
  const mint = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: `${name} visit`, expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json();
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(redeemed.status, 201);
  const value = await redeemed.json();
  assert.ok(value.token.startsWith("ga1."));
  return value.token;
}

const fetchBody = (pageOrigin, extras = {}) => ({
  url: `${pageOrigin}/page`, formats: { markdown: true }, ...extras,
});

test("owner fetch returns markdown, highlights, metadata and a miss", async t => {
  const { request, ownerKey, pageOrigin, store } = await serve(t);
  const res = await request("/api/web/fetch", {
    method: "POST", token: ownerKey,
    data: fetchBody(pageOrigin, { formats: { markdown: true, highlights: true },
      highlightsParams: { query: "quick brown fox", maxPassages: 3 }, tags: ["research"] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.url.endsWith("/page"), body.url);
  assert.equal(body.markdown.requested, true);
  assert.match(body.markdown.data, /# Section One/);
  assert.ok(body.markdown.data.includes("[Section One]") === false, "no bracket artifacts");
  assert.equal(body.highlights.requested, true);
  assert.ok(body.highlights.data.length >= 1, JSON.stringify(body.highlights.data));
  assert.ok(body.highlights.data[0].startsWith("[Section One] "), body.highlights.data[0]);
  assert.equal(body.metadata.title, "Local Page");
  assert.equal(body.metadata.description, "Served by the test page server");
  assert.equal(body.metadata.language, "en");
  assert.deepEqual(body.metadata.headings, ["Section One", "Section Two"]);
  assert.equal(body.cache_metadata.status, "miss");
  assert.equal(body.cache_metadata.age_ms, 0);
  assert.match(body.request_id, /^wf_/);
  // Journaled per request: host, hit/miss, bytes, tags, request_id — and no
  // page content column exists on the journal table at all.
  const row = store.db.prepare("SELECT * FROM web_fetch_log WHERE request_id=?").get(body.request_id);
  assert.ok(row, "fetch journaled");
  assert.equal(row.host, "127.0.0.1");
  assert.equal(row.cache_status, "miss");
  assert.ok(row.bytes > 0);
  assert.deepEqual(JSON.parse(row.tags_json), ["research"]);
  assert.ok(!("markdown" in row) && !("content" in row), "no page content in journal");
  // Key-awareness seam for a future per-key API tier: the credential hash is
  // journaled (never enforced) so per-key counting needs no rework.
  assert.ok(typeof row.credential_hash === "string" && row.credential_hash.length > 0,
    "credential hash journaled");
});

test("migrateWebFetchLogColumns backfills credential_hash on old tables", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-web-fetch-mig-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "mig.sqlite"));
  // Simulate a pre-feature table without the credential_hash column.
  db.exec(`CREATE TABLE web_fetch_log (
    request_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
    host TEXT NOT NULL, cache_status TEXT NOT NULL, bytes INTEGER NOT NULL,
    tags_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO web_fetch_log
    (request_id, room_id, member_id, host, cache_status, bytes, tags_json, created_at)
    VALUES('wf_old','r1','m1','example.com','miss',10,'[]',1)`).run();
  migrateWebFetchLogColumns(db);
  migrateWebFetchLogColumns(db); // idempotent
  const cols = db.prepare("PRAGMA table_info(web_fetch_log)").all().map(c => c.name);
  assert.ok(cols.includes("credential_hash"), "column added");
  const row = db.prepare("SELECT credential_hash FROM web_fetch_log WHERE request_id='wf_old'").get();
  assert.equal(row.credential_hash, null, "old rows read as null");
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='web_fetch_log_key_time'").get();
  assert.ok(idx, "key-time index exists for future per-key counting");
  db.close();
});

test("second fetch is a cache hit with age_ms; maxAgeMs 0 forces fresh", async t => {
  const { request, ownerKey, pageOrigin } = await serve(t);
  const first = await (await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin),
  })).json();
  assert.equal(first.cache_metadata.status, "miss");
  const second = await (await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin),
  })).json();
  assert.equal(second.cache_metadata.status, "hit");
  assert.ok(typeof second.cache_metadata.age_ms === "number" && second.cache_metadata.age_ms >= 0);
  assert.equal(second.request_id === first.request_id, false, "each request gets its own id");
  const fresh = await (await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin, { maxAgeMs: 0 }),
  })).json();
  assert.equal(fresh.cache_metadata.status, "miss");
});

test("highlights-only request returns null markdown but working highlights", async t => {
  const { request, ownerKey, pageOrigin } = await serve(t);
  const body = await (await request("/api/web/fetch", {
    method: "POST", token: ownerKey,
    data: fetchBody(pageOrigin, { formats: { highlights: true }, highlightsParams: { query: "filler words" } }),
  })).json();
  assert.equal(body.markdown.requested, false);
  assert.equal(body.markdown.data, null);
  assert.equal(body.highlights.requested, true);
  assert.ok(body.highlights.data[0].startsWith("[Section Two] "), JSON.stringify(body.highlights.data));
});

test("redirects are followed; redirect to private host is blocked_host", async t => {
  const { request, ownerKey, pageOrigin } = await serve(t);
  const followed = await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin, { url: `${pageOrigin}/redir` }),
  });
  assert.equal(followed.status, 200);
  assert.ok((await followed.json()).url.endsWith("/page"));
  // The redirect target is private: blocked even under the loopback allowance.
  const blocked = await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin, { url: `${pageOrigin}/redir-private` }),
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, "blocked_host");
});

test("full members may fetch; guests get 403 guest_scope_denied", async t => {
  const { request, ownerKey, memberKey, pageOrigin, store } = await serve(t);
  const member = await request("/api/web/fetch", {
    method: "POST", token: memberKey, data: fetchBody(pageOrigin),
  });
  assert.equal(member.status, 200);
  const guestToken = await redeemGuest(request, ownerKey, store);
  const guest = await request("/api/web/fetch", {
    method: "POST", token: guestToken, data: fetchBody(pageOrigin),
  });
  assert.equal(guest.status, 403);
  assert.equal((await guest.json()).error.code, "guest_scope_denied");
});

test("unauthenticated fetch is 401", async t => {
  const { request, pageOrigin } = await serve(t);
  const res = await request("/api/web/fetch", { method: "POST", data: fetchBody(pageOrigin) });
  assert.equal(res.status, 401);
});

test("invalid inputs are typed 4xx, never 500", async t => {
  const { request, ownerKey, pageOrigin } = await serve(t);
  const cases = [
    [{ url: "ftp://example.com/", formats: { markdown: true } }, 400, "invalid_url"],
    [{ url: "http://user:pw@example.com/", formats: { markdown: true } }, 400, "invalid_url"],
    [{ url: "http://example.com:8080/", formats: { markdown: true } }, 400, "invalid_url"],
    [{ url: `${pageOrigin}/page`, formats: {} }, 422, "invalid_fetch_input"],
    [{ url: `${pageOrigin}/page`, formats: { highlights: true } }, 422, "invalid_fetch_input"],
    [{ url: `${pageOrigin}/page`, formats: { markdown: true }, maxAgeMs: -1 }, 422, "invalid_fetch_input"],
    [{ url: `${pageOrigin}/page`, formats: { markdown: true }, tags: new Array(21).fill("x") }, 422, "invalid_fetch_input"],
    [{ url: `${pageOrigin}/page`, formats: { markdown: true }, bogus: 1 }, 422, "invalid_fetch_input"],
    [{ url: `${pageOrigin}/page`, formats: { markdown: true, summary: true } }, 422, "invalid_fetch_input"],
    [{ url: `${pageOrigin}/page`, formats: { highlights: true }, highlightsParams: { query: "x", extra: 1 } }, 422, "invalid_fetch_input"],
  ];
  for (const [data, status, code] of cases) {
    const res = await request("/api/web/fetch", { method: "POST", token: ownerKey, data });
    assert.equal(res.status, status, JSON.stringify(data));
    const body = await res.json();
    assert.equal(body.error.code, code, JSON.stringify(data));
    assert.match(body.request_id, /^wf_/, "typed failures carry a request id");
  }
});

test("non-HTML is 415 unsupported_content; server errors are 502 fetch_failed", async t => {
  const { request, ownerKey, pageOrigin } = await serve(t);
  const json = await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin, { url: `${pageOrigin}/json` }),
  });
  assert.equal(json.status, 415);
  assert.equal((await json.json()).error.code, "unsupported_content");
  const err = await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin, { url: `${pageOrigin}/err` }),
  });
  assert.equal(err.status, 502);
  assert.equal((await err.json()).error.code, "fetch_failed");
});

test("failed fetches are journaled but never consume quota", async t => {
  const { request, memberKey, pageOrigin, store } = await serve(t);
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO web_fetch_log
    (request_id, room_id, member_id, host, cache_status, bytes, tags_json, created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  store.transaction(() => {
    for (let i = 0; i < 100; i++) {
      insert.run(`wf_err_${i}`, "commons", "member", "example.com", "error", 0, "[]", now - 1000);
    }
  });
  const res = await request("/api/web/fetch", {
    method: "POST", token: memberKey, data: fetchBody(pageOrigin),
  });
  assert.equal(res.status, 200, "error rows must not count toward quota");
  const rows = store.db.prepare("SELECT COUNT(*) AS n FROM web_fetch_log WHERE cache_status='error'").get().n;
  assert.equal(rows, 100);
});

test("the old roomId web/fetch path is not served", async t => {
  const { request, ownerKey, pageOrigin } = await serve(t);
  const res = await request("/api/rooms/commons/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin),
  });
  assert.equal(res.status, 404);
});
test("quota exhaustion is 429 with Retry-After and retry info", async t => {
  const { request, ownerKey, memberKey, pageOrigin, store } = await serve(t);
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO web_fetch_log
    (request_id, room_id, member_id, host, cache_status, bytes, tags_json, created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  // Fill the member's daily quota with journaled rows inside one transaction.
  store.transaction(() => {
    for (let i = 0; i < 100; i++) {
      insert.run(`wf_quota_${i}`, "commons", "member", "example.com", "hit", 10, "[]", now - 1000);
    }
  });
  const res = await request("/api/web/fetch", {
    method: "POST", token: memberKey, data: fetchBody(pageOrigin),
  });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"), "Retry-After header present");
  const body = await res.json();
  assert.equal(body.error.code, "rate_limited");
  assert.ok(typeof body.retryAfterMs === "number" && body.retryAfterMs >= 0);
  assert.ok(typeof body.resetAt === "number" && body.resetAt > now);
  // The owner quota is separate: the owner can still fetch.
  const owner = await request("/api/web/fetch", {
    method: "POST", token: ownerKey, data: fetchBody(pageOrigin),
  });
  assert.equal(owner.status, 200);
});
