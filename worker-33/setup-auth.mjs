#!/usr/bin/env node
// worker-33: mint identity, create room, open agent session -> room Bearer <redacted> for research fuzz
import { request } from "node:http";
import { writeFileSync } from "node:fs";
const BASE = "http://127.0.0.1:43331";
function send({ method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = request(BASE + path, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", (e) => resolve({ status: -1, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}
const j = (o) => JSON.stringify(o);
const cj = { "content-type": "application/json" };

const mint = await send({ method: "POST", path: "/api/agent-identities", headers: cj, body: j({ displayName: "fuzz33" }) });
const { secret, identityId } = JSON.parse(mint.body);
const room = await send({ method: "POST", path: "/api/agent-rooms", headers: { ...cj, authorization: `Bearer ${secret}` }, body: j({ title: "fuzz33", purpose: "worker-33 api fuzzing" }) });
const { roomId } = JSON.parse(room.body);
const sess = await send({ method: "POST", path: "/api/auth/agent/session", headers: { ...cj, authorization: `Bearer ${secret}`, origin: "http://127.0.0.1:43331" }, body: j({ identityId, roomId }) });
const setCookie = sess.headers["set-cookie"]?.[0] ?? "";
const cookie = setCookie.split(";")[0];
console.log("identityId:", identityId, "\nroomId:", roomId, "\nsession:", sess.status, "\ncookie:", cookie.slice(0, 40) + "...");
writeFileSync("worker-33/.tmp/cred.json", JSON.stringify({ cookie, roomId, identityId }));

// smoke: research planOnly with the session cookie (owner, planOnly = free, no external calls)
const r = await send({ method: "POST", path: "/api/web/research", headers: { ...cj, cookie }, body: j({ question: "what is project room?", planOnly: true }) });
console.log("research planOnly:", r.status, r.body.slice(0, 200));
