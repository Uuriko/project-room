import http from "node:http";
import net from "node:net";
const srv = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("data", (c) => { buf = Buffer.concat([buf, c]); if (buf.includes("\r\n\r\n") && buf.length > 60) { console.log("RAW REQUEST:", JSON.stringify(buf.slice(0, 400).toString("latin1"))); sock.end(); } });
});
await new Promise((r) => srv.listen(14356, "127.0.0.1", r));
await new Promise((resolve) => {
  const req = http.request("http://127.0.0.1:14356/x", { method: "GET", headers: { "Content-Type": "application/json" } },
    (res) => { res.resume(); res.on("end", resolve); });
  req.on("error", () => resolve());
  req.write(Buffer.from('{"a":1}'));
  req.end();
});
srv.close();
