import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import net from "node:net";
const f = await createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const HOST = `127.0.0.1:${port}`;
function rawRequest(raw, timeoutMs = 6000) {
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
const H = h => h.replaceAll("HOST", HOST);
const cases = [
  ["trace", H("TRACE /api/guest-agent-links HTTP/1.1\r\nHost: HOST\r\nConnection: close\r\n\r\n")],
  ["connect", H("CONNECT /api/guest-agent-links HTTP/1.1\r\nHost: HOST\r\nConnection: close\r\n\r\n")],
  ["get-with-body", H("GET /api/guest-agent-links HTTP/1.1\r\nHost: HOST\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")],
  ["get-chunked", H("GET /api/guest-agent-links HTTP/1.1\r\nHost: HOST\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n")],
  ["put", H("PUT /api/guest-agent-links HTTP/1.1\r\nHost: HOST\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")],
  ["options-star", H("OPTIONS * HTTP/1.1\r\nHost: HOST\r\nConnection: close\r\n\r\n")],
  ["get-trailing-slash", H("GET /api/guest-agent-links/ HTTP/1.1\r\nHost: HOST\r\nConnection: close\r\n\r\n")],
];
for (const [name, raw] of cases) {
  const r = await rawRequest(raw);
  const body = (r.data.split("\r\n\r\n")[1] || "").slice(0, 120).replaceAll("\n", " ");
  console.log(name, "->", r.status, r.ms + "ms", JSON.stringify(body));
}
server.closeStreams(); server.closeAllConnections();
await new Promise(r2 => server.close(r2));
f.store.close();
