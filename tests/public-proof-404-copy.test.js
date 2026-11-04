// PPR (public proof residuals): honest 404 scope for the two stranger
// faces that used to overclaim — the disabled agent page and the
// unavailable public receipt — plus the link-suppression pin for §A:
// while agent pages are off, no served first-party surface emits a
// /u/ link.
//
// The receipt copy matters because a receipt that was once listed can
// later stop resolving (UT2 07-09 F5: a settled, wall-listed receipt
// became reachable by no path). A 404 that says "not found" as if the
// id were invented misstates what the server knows: it knows only
// that no public receipt with this id is available now. The copy must
// name both possibilities and claim neither.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function live(t, extra = {}) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...extra });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const request = path => fetch(`${origin}${path}`);
  return { request };
}

const MISSING_RECEIPT = "pwr_0000000000000000000000000000000000000000000000000000000000000000";

test("disabled agent page 404 states the server-wide scope, for real and bogus slugs alike", async t => {
  const { request } = await live(t, { publicAgentPages: false });
  for (const path of ["/u/jill", "/u/definitely-bogus-zzz", "/api/public/agents/jill"]) {
    const res = await request(path);
    assert.equal(res.status, 404, path);
    const body = await res.json();
    assert.equal(body.error.code, "agent_page_unavailable", path);
    assert.match(body.error.message, /disabled on this server/, path);
    assert.match(body.error.message, /whether or not/, path);
  }
});

test("with agent pages off, the directory and sitemap emit no /u/ link", async t => {
  const { request } = await live(t, { publicAgentPages: false });
  for (const path of ["/agents", "/sitemap.xml"]) {
    const res = await request(path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.ok(!text.includes("/u/"), `${path} must not emit a /u/ link while agent pages are off`);
  }
});

test("unavailable receipt 404 names the true scope on the HTML, JSON and share faces", async t => {
  const { request } = await live(t);
  for (const path of [`/receipts/${MISSING_RECEIPT}`, `/receipts/${MISSING_RECEIPT}.json`, `/receipts/${MISSING_RECEIPT}/og.png`]) {
    const res = await request(path);
    assert.equal(res.status, 404, path);
    const body = await res.json();
    assert.equal(body.error.code, "not_found", path);
    assert.match(body.error.message, /No public receipt with this id is available/, path);
    assert.match(body.error.message, /never have been published/, path);
    assert.match(body.error.message, /unpublished or made private/, path);
  }
});

test("public-work receipt 404 and its hint claim neither existence nor non-existence", async t => {
  const { request } = await live(t);
  const res = await request(`/api/public-work/receipts/${MISSING_RECEIPT}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "public_receipt_not_found");
  assert.match(body.error.message, /never have been published/);
  assert.match(body.error.message, /unpublished or made private/);
  const blob = JSON.stringify(body);
  assert.ok(!blob.includes("does not exist"), `hint must not assert non-existence: ${blob}`);
});
