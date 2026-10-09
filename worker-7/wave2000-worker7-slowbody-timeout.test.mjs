// WAVE-2000 G02 worker-7 fail-first test.
// Finding: server/http.mjs sets server.requestTimeout = 15000, but on
// Node 24 an incomplete chunked POST body is not cut off at 15s —
// empirically ~23s before the 408 arrives (and sub-15s settings enforce
// even later: 2s -> ~30s, 5s -> ~60s on bare Node). A slow-drip client can
// hold a connection (and the awaiting handler) well past the configured
// limit. Desired: 408 within requestTimeout + slack.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("incomplete chunked body is cut off near the configured requestTimeout", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-worker7-slowbody-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const started = Date.now();
  const verdict = await new Promise(resolve => {
    const hardCap = setTimeout(() => { sock.destroy(); resolve({ status: "TIMEOUT", ms: Date.now() - started }); }, 65000);
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        "POST /api/guest-agent-links/preview HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        `Origin: ${origin}\r\n` +
        "Content-Type: application/json\r\n" +
        "Transfer-Encoding: chunked\r\n\r\n"
      ); // never send any body bytes
    });
    sock.on("data", chunk => {
      const line = chunk.toString().split("\r\n")[0];
      if (/ 408 /.test(line)) { clearTimeout(hardCap); sock.destroy(); resolve({ status: 408, ms: Date.now() - started }); }
    });
    sock.on("close", () => { clearTimeout(hardCap); resolve({ status: "CLOSED", ms: Date.now() - started }); });
    sock.on("error", () => {});
  });
  assert.equal(verdict.status, 408, `expected 408, got ${verdict.status}`);
  assert.ok(verdict.ms <= 20000, `408 arrived after ${verdict.ms}ms; configured requestTimeout is 15000`);
});
