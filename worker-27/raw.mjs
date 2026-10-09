// WORKER 27 raw-path probes (fresh boot, no rate burn)
import net from "node:net";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

let server = null, fixture = null, port = null, origin = null;
async function boot() {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port; origin = `http://127.0.0.1:${port}`;
}
function raw(name, payload, waitMs = 2500, timeoutMs = 10000) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const finish = (s) => { if (!done) { done = true; sock.destroy();
      const line = data.split("\r\n")[0];
      const bodyStart = data.indexOf("\r\n\r\n");
      const body = bodyStart >= 0 ? data.slice(bodyStart + 4, bodyStart + 200) : "";
      console.log(name, "->", s, "|", line, "|", JSON.stringify(body)); resolve(); } };
    const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish("CLOSED"); });
    sock.on("error", e => { clearTimeout(timer); console.log(name, "-> SOCKET-ERR", e.message); resolve(); });
    setTimeout(() => { if (!done && data) { clearTimeout(timer); finish("RESP"); } }, waitMs);
  });
}
await boot();
console.log("boot", origin);
const host = `127.0.0.1:${port}`;
await raw("oversize-declared", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n`);
await raw("huge-body-200k", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 200000\r\n\r\n` + "x".repeat(200000));
await raw("missing-content-type", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Length: 30\r\n\r\n{"identityId":"whatever"}`);
await raw("trickle-then-close", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n`);
await raw("chunked", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n14\r\n{"identityId":"x"}\r\n0\r\n\r\n`);
await raw("negative-content-length", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: -5\r\n\r\n`);
await raw("both-cl-and-chunked", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`);
try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
try { fixture.store.close(); } catch {}
console.log("done");
process.exit(0);
