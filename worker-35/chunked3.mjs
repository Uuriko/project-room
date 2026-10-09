import http from "node:http";
import { readFileSync } from "node:fs";
const ck = readFileSync("worker-35/.tmp/cookies.txt", "utf8").match(/^AUTHD=(.*)$/m)[1];

// bare node server: does it 400 a chunked GET?
const bare = http.createServer((req, res) => {
  let n = 0; req.on("data", (c) => n += c.length); req.on("end", () => { res.end(`method=${req.method} te=${req.headers["transfer-encoding"]} bytes=${n}`); });
});
bare.on("clientError", (err, sock) => { console.log("BARE clientError:", err.code || err.message); sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
await new Promise((r) => bare.listen(14355, "127.0.0.1", r));

function send(port, headers, bodyBuf) {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/x`, { method: "GET", headers }, (res) => {
      let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve(`status=${res.statusCode} body=${b.slice(0, 120)}`));
    });
    req.on("error", (e) => resolve(`ERROR ${e.code || e.message}`));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}
console.log("bare chunked GET:", await send(14355, { "Content-Type": "application/json" }, Buffer.from('{"a":1}')));
console.log("app  chunked GET:", await send(4355, { Cookie: ck, "Content-Type": "application/json" }, Buffer.from('{"a":1}')));
bare.close();
