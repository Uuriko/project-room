// Guild-03 raw-socket fuzz: cases node's fetch refuses to send.
// Null byte in Authorization header, TRACE method, malformed request line.
import { appendFileSync } from "node:fs";
import { bootFuzzServer } from "./fuzzlib.mjs";
import { connect } from "node:net";

const MD = new URL("../fuzz.md", import.meta.url).pathname;
const { origin, ownerToken, roomId, close } = await bootFuzzServer();
const port = new URL(origin).port;

function rawSend(payload, timeoutMs = 8000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = connect(port, "127.0.0.1");
    let data = "";
    const done = (outcome) => { try { sock.destroy(); } catch {} resolve({ ...outcome, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => done({ status: "HANG" }), timeoutMs);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", c => { data += c.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer);
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(data);
      done({ status: m ? m[1] : ("CLOSED:" + data.slice(0, 80)) });
    });
    sock.on("error", e => { clearTimeout(timer); done({ status: "SOCKERR:" + e.message.slice(0, 60) }); });
  });
}

const cases = [
  ["null-byte in Authorization", `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ab\x00cd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`],
  ["TRACE method", `TRACE /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`],
  ["malformed request line", `GETTT /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`],
  ["no headers at all", `GET /mcp HTTP/1.0\r\n\r\n`],
  ["huge header", `GET /mcp HTTP/1.1\r\nHost: x\r\nX-Evil: ${"y".repeat(100000)}\r\nConnection: close\r\n\r\n`],
  ["null byte in path", `GET /api/rooms/${roomId}/feedback/a\x00b HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${ownerToken}\r\nConnection: close\r\n\r\n`],
  ["bad content-length", `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: notanumber\r\nConnection: close\r\n\r\n{}`],
  ["negative content-length", `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\nConnection: close\r\n\r\n`],
];
appendFileSync(MD, `\n## F-RAW — ${cases.length} raw-socket hostile inputs\n`);
for (const [name, payload] of cases) {
  const r = await rawSend(payload);
  const bad = r.status === "HANG" || r.status === 500 || String(r.status).startsWith("CLOSED");
  appendFileSync(MD, `- [${r.status}] ${r.ms}ms raw-socket — ${name}${bad ? "  <-- INVESTIGATE" : ""}\n`);
  console.log(name, "->", r.status, r.ms + "ms");
}
appendFileSync(MD, `\nverdict: raw-socket probe complete\n`);
await close();
