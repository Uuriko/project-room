// The offline page is the face of the app when a phone loses its network. It
// ships one inline <style> (kept single-file so the service worker caches
// exactly one document). The site-wide CSP is style-src 'self' with no
// 'unsafe-inline', which silently blocks that block and renders an unstyled
// page. The server therefore allowlists the page's exact style block by
// sha256 on the /offline.html response. These tests fail if the served hash
// drifts from the file's actual <style> (edit the style -> the hash constant
// in server/http.mjs must move with it) and fail if /offline.html ever stops
// carrying the exception.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function offlineStyleHash() {
  const html = readFileSync(new URL("../offline.html", import.meta.url), "utf8");
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(match, "offline.html must keep its single inline <style> block");
  return `sha256-${createHash("sha256").update(match[1], "utf8").digest("base64")}`;
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-offline-csp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
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

test("the /offline.html CSP allowlists the page's own inline style block", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/offline.html`);
  assert.equal(response.status, 200, "GET /offline.html");
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.ok(
    csp.includes(offlineStyleHash()),
    `the offline page CSP must allowlist its exact style block by hash; got: ${csp}`
  );
  assert.ok(csp.includes("style-src 'self'"), "the base style-src stays intact");
});

test("other documents do not inherit the offline style exception", async t => {
  const origin = await serve(t);
  for (const path of ["/", "/about.html"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, `GET ${path}`);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.ok(!csp.includes("sha256-"), `only /offline.html gets the hash exception (GET ${path})`);
  }
});
