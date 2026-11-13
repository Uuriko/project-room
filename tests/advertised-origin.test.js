// Self-hosted discovery origin: a fresh instance advertises its own origin on
// /llms.txt, /llms-full.txt, agent.json, agent-card.json, the sitemap and the
// canonical/OG tags; hosted output stays byte-identical to the authored bytes.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { discoveryDoc, ROOM_ORIGIN } from "../server/agent-discovery.mjs";
import {
  advertisedText, advertisedHtml, advertisedDocument, advertisedDocumentBody, advertisedOrigin, isHostedOrigin, SELF_HOSTED_CARD_UNSIGNED_REASON,
} from "../server/advertised-origin.mjs";

const HOSTED_HOST = new URL(ROOM_ORIGIN).host;
const DISCOVERY = ["/llms.txt", "/llms-full.txt", "/.well-known/agent.json", "/.well-known/agent-card.json"];
const SIGNATURE_FIELDS = ["signatures", "cardSignature", "signedRevision", "keyId", "signatureAgentId", "publicKey"];

async function start(t, origin) {
  const directory = mkdtempSync(join(tmpdir(), "advertised-origin-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
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
  return {
    port,
    // Node's fetch cannot set Host; the server pins Host to its configured origin.
    get: (path, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path, headers: { host, accept: "text/plain, application/json, */*" } }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      }).on("error", reject);
    }),
  };
}

test("helper: hosted or absent origin is a strict no-op (same string, same object)", () => {
  const text = `see ${ROOM_ORIGIN}/mcp`;
  const doc = discoveryDoc("/llms.txt");
  for (const origin of [undefined, null, "", ROOM_ORIGIN, `${ROOM_ORIGIN}/`]) {
    assert.equal(isHostedOrigin(origin), true);
    assert.equal(advertisedOrigin(origin), ROOM_ORIGIN);
    assert.equal(advertisedText(text, origin), text);
    assert.equal(advertisedDocument(doc, origin), doc);
    assert.equal(advertisedDocumentBody(doc.type, doc.body, origin), doc.body);
  }
  assert.equal(isHostedOrigin("https://room.example"), false);
  assert.equal(advertisedText(text, "https://room.example/"), "see https://room.example/mcp");
});

test("helper: a rewritten card drops the project signature and says why", () => {
  const signed = JSON.stringify({ name: "x", url: `${ROOM_ORIGIN}/mcp`, keyId: "k", cardSignature: "s", signedRevision: "r", signatureAgentId: "a", publicKey: "p", signatures: [{ protected: "p" }] }, null, 2) + "\n";
  const out = JSON.parse(advertisedDocumentBody("application/json; charset=utf-8", signed, "https://room.example"));
  assert.equal(out.url, "https://room.example/mcp");
  for (const field of SIGNATURE_FIELDS) assert.equal(field in out, false, field);
  assert.equal(out.signed, false);
  assert.equal(out.unsignedReason, SELF_HOSTED_CARD_UNSIGNED_REASON);
  // JSON without a signature envelope keeps its bytes apart from the origin.
  const plain = `{"u":"${ROOM_ORIGIN}/a"}\n`;
  assert.equal(advertisedDocumentBody("application/json", plain, "https://room.example"), `{"u":"https://room.example/a"}\n`);
});

for (const [label, origin] of [["loopback default", null], ["configured https origin", "https://room.selfhost.example"]]) {
  test(`self-hosted (${label}): discovery, sitemap and page tags name the instance origin`, async t => {
    const server = await start(t, origin);
    const own = origin ?? `http://127.0.0.1:${server.port}`;
    const host = new URL(own).host;
    const bodies = {};
    for (const path of [...DISCOVERY, "/sitemap.xml", "/", "/about", "/receipts"]) {
      const res = await server.get(path, host);
      assert.equal(res.status, 200, `${path} status`);
      const text = res.bytes.toString("utf8");
      bodies[path] = text;
      // HTML pages keep authored body links (e.g. the hosted sample receipt); only their discovery tags move.
      const checked = path === "/" || path === "/about" || path === "/receipts" ? (text.match(/<(?:link|meta)\b[^>]*>/gi) ?? []).filter(tag => !/rel="(?:preload|stylesheet|icon|manifest)"/i.test(tag)).join("\n") : text;
      assert.equal(checked.includes(ROOM_ORIGIN), false, `${path} still names ${ROOM_ORIGIN}`);
      assert.equal(String(res.headers.link ?? "").includes(ROOM_ORIGIN), false, `${path} Link header names the hosted origin`);
    }
    assert.match(bodies["/llms.txt"], new RegExp(`${own.replace(/[.]/g, "\\.")}/llms-full\\.txt`));
    assert.ok(bodies["/llms-full.txt"].includes(`${own}/`));
    assert.ok(bodies["/sitemap.xml"].includes(`<loc>${own}/`));
    assert.match(bodies["/"], new RegExp(`<link rel="canonical" href="${own.replace(/[.]/g, "\\.")}/">`));
    assert.match(bodies["/"], new RegExp(`property="og:url" content="${own.replace(/[.]/g, "\\.")}/"`));
    assert.match(bodies["/"], new RegExp(`property="og:image" content="${own.replace(/[.]/g, "\\.")}/og/home\\.png"`));
    assert.match(bodies["/about"], new RegExp(`<link rel="canonical" href="${own.replace(/[.]/g, "\\.")}/about">`));
    const sitemap = await server.get("/sitemap.xml", host);
    assert.ok(String(sitemap.headers.link).includes(`<${own}/sitemap.xml>; rel="canonical"`), sitemap.headers.link);
    for (const path of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const card = JSON.parse(bodies[path]);
      for (const field of SIGNATURE_FIELDS) assert.equal(field in card, false, `${path} ${field}`);
      assert.equal(card.signed, false);
      // Unsigned builds are already marked unsigned; a signed build is unsigned here with our reason (helper test).
      assert.ok(card.supportedInterfaces.every(iface => iface.url === own || iface.url.startsWith(`${own}/`)), path);
    }
  });
}

test("hosted mode: served bytes equal the authored hosted bytes", async t => {
  const server = await start(t, ROOM_ORIGIN);
  for (const path of ["/llms.txt", "/llms-full.txt", "/.well-known/agent.json", "/.well-known/agent-card.json"]) {
    const res = await server.get(path, HOSTED_HOST);
    assert.equal(res.status, 200, path);
    assert.equal(res.bytes.toString("utf8"), discoveryDoc(path).body, `${path} differs from the authored hosted bytes`);
  }
  const sitemap = await server.get("/sitemap.xml", HOSTED_HOST);
  assert.equal(sitemap.status, 200);
  assert.ok(sitemap.bytes.toString("utf8").includes(`<loc>${ROOM_ORIGIN}/`));
  assert.ok(String(sitemap.headers.link).includes(`<${ROOM_ORIGIN}/sitemap.xml>; rel="canonical"`));
  const home = await server.get("/", HOSTED_HOST);
  assert.equal(home.status, 200);
  assert.match(home.bytes.toString("utf8"), /<link rel="canonical" href="https:\/\/room\.trydemigod\.com\/">/);
});

test("hosted and self-hosted differ only by origin (except the unsigned card marker)", async t => {
  const hosted = await start(t, ROOM_ORIGIN);
  const local = await start(t, null);
  const own = `http://127.0.0.1:${local.port}`;
  for (const path of ["/llms.txt", "/llms-full.txt", "/sitemap.xml", "/", "/about"]) {
    const a = (await hosted.get(path, HOSTED_HOST)).bytes.toString("utf8");
    const b = (await local.get(path, `127.0.0.1:${local.port}`)).bytes.toString("utf8");
    const expected = path === "/" || path === "/about" ? advertisedHtml(a, own) : a.split(ROOM_ORIGIN).join(own);
    assert.equal(b, expected, `${path} differs by more than the origin`);
  }
});
