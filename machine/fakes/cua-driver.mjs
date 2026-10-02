import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const args = process.argv.slice(2);
appendFileSync(join(home, "argv-log"), `cua-driver ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
appendFileSync(join(home, "env-log"), `${Object.entries(process.env).map(([key, value]) => `${key}=${value}`).join("\n")}\n---\n`);

if (args[0] === "--version") {
  process.stdout.write("cua-driver 0.32.0-fake\n");
  process.exit(0);
}
if (args[0] === "permissions") {
  const path = join(home, "grants.json");
  const body = existsSync(path)
    ? readFileSync(path, "utf8")
    : JSON.stringify({ accessibility: true, screen_recording: true, attribution: "driver-daemon" });
  process.stdout.write(body);
  process.exit(0);
}
if (args[0] !== "mcp") process.exit(0);

let buffer = Buffer.alloc(0);
let id = 0;
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function reply(requestId, result) {
  send({ jsonrpc: "2.0", id: requestId, result });
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    id = message.id ?? id;
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "cua-driver", version: "0.32.0-fake" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: ["screenshot", "click", "type", "key", "scroll", "list_apps"].map(name => ({ name })) });
    } else if (message.method === "tools/call") {
      appendFileSync(join(home, "argv-log"), `tools/call ${message.params?.name}\n`);
      const data = Buffer.from("png-bytes").toString("base64");
      reply(message.id, { content: [{ type: "image", data, mimeType: "image/png" }] });
    }
  }
});
