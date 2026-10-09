import http from "node:http";
import { readFileSync } from "node:fs";
const ck = readFileSync("worker-35/.tmp/cookies.txt", "utf8").match(/^AUTHD=(.*)$/m)[1];
const body = JSON.stringify({ admin: true });
const req = http.request("http://127.0.0.1:4355/api/account/onboarding",
  { method: "GET", headers: { Cookie: ck, "Content-Type": "application/json" } },
  (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => { console.log("status", res.statusCode); console.log(b.slice(0, 400)); }); });
req.on("error", (e) => console.log("ERROR", e.code || e.message));
req.write(body); // no Content-Length -> chunked
req.end();
