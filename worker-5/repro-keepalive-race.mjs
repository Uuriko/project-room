// Repro: keep-alive client racing a request onto the socket the server
// half-closes after a 413 drain gets "socket hang up". Server stays healthy.
// server/http.mjs ~line 4995: on 413, after res finish, drains then socket.end().
// A keep-alive agent reusing that socket for the next request loses the race.
// Run against a local server: node repro-keepalive-race.mjs [port]
import http from "node:http";
const PORT = Number(process.argv[2] || 4195);
function post(body, label, agent) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/guest-invites/preview",
      headers: { Origin: `http://127.0.0.1:${PORT}`, "Content-Type": "application/json" }, agent, timeout: 8000 }, (res) => {
      res.resume(); res.on("end", () => { console.log(label, "->", res.statusCode); resolve(); });
    });
    r.on("timeout", () => { console.log(label, "-> TIMEOUT"); r.destroy(); resolve(); });
    r.on("error", (e) => { console.log(label, "-> ERR:", e.message); resolve(); });
    r.write(body); r.end();
  });
}
const big = JSON.stringify({ inviteCode: "x".repeat(16400) }); // > 16384 cap -> 413
const deep = (() => { let d = '{"inviteCode":"x"}'; for (let i = 0; i < 2000; i++) d = '{"w":' + d + '}'; return d; })();
console.log("--- fresh connection per request (no keep-alive) ---");
const noKA = new http.Agent({ keepAlive: false });
await post(big, "413-case      ", noKA);
await post(deep, "deep-after-413", noKA);
console.log("--- keep-alive agent (default) ---");
const ka = new http.Agent({ keepAlive: true });
await post(big, "413-case      ", ka);
await post(deep, "deep-after-413", ka); // <- socket hang up here (client-visible only)
await post(deep, "deep-again    ", ka);
console.log("done: server is healthy throughout; only the raced request fails client-side");
