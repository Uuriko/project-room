import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import net from "node:net";
const f = await createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
function rawRequest(raw, timeoutMs = 20000) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    const t0 = Date.now(); let data = "";
    let done = false;
    const finish = (status) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve({ status, ms: Date.now() - t0, data }); };
    const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
    sock.on("connect", () => sock.write(raw));
    sock.on("data", c => { data += c.toString("latin1"); });
    sock.on("end", () => { const m = data.match(/^HTTP\/\d\.\d (\d{3})/); finish(m ? Number(m[1]) : "EOF"); });
    sock.on("error", e => finish("ERR:" + e.message));
    sock.on("close", () => { const m = data.match(/^HTTP\/\d\.\d (\d{3})/); if (!done) finish(m ? Number(m[1]) : "CLOSED"); });
  });
}
let r = await rawRequest("GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
console.log("raw-plain-GET:", r.status, r.ms, JSON.stringify(r.data.split("\r\n\r\n")[1] || r.data.split("\r\n").slice(0,6).join(" | ")));
r = await rawRequest("GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n");
console.log("raw-GET-with-UA:", r.status, r.ms);
r = await rawRequest("TRACE /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
console.log("raw-TRACE:", r.status, r.ms, JSON.stringify((r.data.split("\r\n\r\n")[1] || "").slice(0, 200)));
r = await rawRequest("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
console.log("raw-GET-health:", r.status, r.ms);
// unterminated headers with long timeout: does the server eventually 408?
r = await new Promise(resolve => {
  const sock = net.connect(port, "127.0.0.1");
  const t0 = Date.now(); let data = "";
  sock.on("connect", () => sock.write("GET /api/guest-agent-links HTTP/1.1\r\nHost: 127.0.0.1\r\n"));
  const timer = setTimeout(() => { sock.destroy(); resolve({ status: "TIMEOUT-20s", ms: Date.now() - t0, data }); }, 20000);
  sock.on("data", c => { data += c.toString("latin1"); });
  sock.on("close", () => { clearTimeout(timer); const m = data.match(/^HTTP\/\d\.\d (\d{3})/); resolve({ status: m ? Number(m[1]) : "CLOSED", ms: Date.now() - t0, data }); });
});
console.log("unterminated-headers-20s:", r.status, r.ms, JSON.stringify(r.data.slice(0, 120)));
server.closeStreams(); server.closeAllConnections();
await new Promise(r2 => server.close(r2));
f.store.close();
