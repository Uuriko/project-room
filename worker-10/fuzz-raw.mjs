#!/usr/bin/env node
// WORKER-10 supplement: raw request-line / header smuggling shapes with the
// CORRECT Host header so they actually reach the two shard handlers.
// Reports first status line of each response.
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const HOST = "127.0.0.1", TIMEOUT = 8000;
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w10raw-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("commons"));
const server = createRoomServer({ store });
await new Promise((r) => server.listen(0, HOST, r));
const PORT = server.address().port;
const H = `Host: ${HOST}:${PORT}`;

function raw(data, label) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, HOST, () => s.write(data));
    const t = setTimeout(() => { s.destroy(); resolve({ label, out: "TIMEOUT" }); }, TIMEOUT);
    let buf = "";
    s.on("data", (c) => { buf += c.toString("latin1"); });
    s.on("end", () => { clearTimeout(t); resolve({ label, out: buf.split("\r\n")[0] }); });
    s.on("error", (e) => { clearTimeout(t); resolve({ label, out: "ERR:" + (e.code || e.message) }); });
  });
}

const GH = "/api/auth/github/start";
const GL = "/api/guest-agent-links";
const cases = [
  // absolute-form request target
  [`GET http://${HOST}:${PORT}${GH} HTTP/1.1\r\n${H}\r\n\r\n`, "gh:absolute-form"],
  [`GET http://${HOST}:${PORT}${GL} HTTP/1.1\r\n${H}\r\n\r\n`, "gl:absolute-form"],
  // absolute-form with different authority than Host header
  [`GET http://evil.example${GH} HTTP/1.1\r\n${H}\r\n\r\n`, "gh:absolute-form-evil-authority"],
  // duplicate Host: correct first, evil second (and reverse)
  [`GET ${GH} HTTP/1.1\r\n${H}\r\nHost: evil.example\r\n\r\n`, "gh:dup-host-correct-first"],
  [`GET ${GH} HTTP/1.1\r\nHost: evil.example\r\n${H}\r\n\r\n`, "gh:dup-host-evil-first"],
  // duplicate Content-Length on a POST to github/start
  [`POST ${GH} HTTP/1.1\r\n${H}\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!`, "gh:post-dup-cl"],
  // both Content-Length and Transfer-Encoding (clash)
  [`POST ${GH} HTTP/1.1\r\n${H}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n`, "gh:post-cl-te-clash"],
  // chunked GET to guest-agent-links
  [`GET ${GL} HTTP/1.1\r\n${H}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`, "gl:chunked-get"],
  // GET with a body declared
  [`GET ${GH} HTTP/1.1\r\n${H}\r\nContent-Length: 11\r\n\r\nhello world`, "gh:get-with-body"],
  // header name case / whitespace oddities
  [`GET ${GH} HTTP/1.1\r\n${H}\r\nX-Foo : bar\r\n\r\n`, "gh:space-before-colon"],
  [`GET ${GL} HTTP/1.1\r\n${H}\r\nOrigin:http://evil.example\r\n\r\n`, "gl:origin-no-space"],
  [`GET ${GL} HTTP/1.1\r\n${H}\r\nOrigin: http://evil.example \r\n\r\n`, "gl:origin-trailing-space"],
  // encoded NUL in Host
  [`GET ${GH} HTTP/1.1\r\nHost: ${HOST}%00:${PORT}\r\n\r\n`, "gh:host-pct-nul"],
  // OPTIONS * and TRACE with body
  [`OPTIONS * HTTP/1.1\r\n${H}\r\n\r\n`, "options-star"],
  [`TRACE ${GL} HTTP/1.1\r\n${H}\r\n\r\n`, "gl:trace"],
  // tab in request line (obsolete folding attempt in target)
  [`GET ${GH}\tHTTP/1.1\r\n${H}\r\n\r\n`, "gh:tab-in-target"],
  // extremely long method token
  [`${"X".repeat(64)} ${GH} HTTP/1.1\r\n${H}\r\n\r\n`, "gh:long-method"],
  // HTTP/1.0 with Host (keep-alive check)
  [`GET ${GL} HTTP/1.0\r\n${H}\r\n\r\n`, "gl:http10-with-host"],
  // query with fragment (fragments never reach server, but raw can send)
  [`GET ${GH}?a=1#frag HTTP/1.1\r\n${H}\r\n\r\n`, "gh:fragment-in-target"],
];
for (const [d, l] of cases) {
  const r = await raw(d, l);
  console.log(`${l} => ${r.out}`);
}
server.close();
store.close?.();
process.exit(0);
