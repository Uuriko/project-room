import http from "node:http";
import { readFileSync } from "node:fs";
const ck = readFileSync("worker-35/.tmp/cookies.txt", "utf8").match(/^AUTHD=(.*)$/m)[1];

async function one(name, headers, bodyBuf) {
  await new Promise((resolve) => {
    const req = http.request("http://127.0.0.1:4355/api/account/onboarding",
      { method: "GET", headers: { Cookie: ck, ...headers } },
      (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => { console.log(name, "status", res.statusCode, "headers", JSON.stringify(res.headers), "body", JSON.stringify(b.slice(0, 200))); resolve(); }); });
    req.on("error", (e) => { console.log(name, "ERROR", e.code || e.message); resolve(); });
    if (bodyBuf) { req.write(bodyBuf); }
    req.end();
  });
}
await one("chunked-json", { "Content-Type": "application/json" }, Buffer.from('{"admin":true}'));
await one("no-body-json-ct", { "Content-Type": "application/json" }, null);
await one("plain", {}, null);
await one("chunked-no-ct", {}, Buffer.from("hello"));
