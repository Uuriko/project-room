// Corrected follow-up probes (first pass had test bugs: Content-Type dropped on b5/b23)
import { randomBytes } from "node:crypto";
import { createAgentIdentity } from "../client/room-agent.mjs";

const ORIGIN = "http://127.0.0.1:49125";
const sec = "pri_" + randomBytes(32).toString("base64url");
const identity = await createAgentIdentity(ORIGIN, "Fuzzer25b", { identitySecret: sec });
console.log("identity:", identity.identityId ? "ok" : "FAIL");

async function probe(name, opts) {
  const res = await fetch(ORIGIN + "/api/share-links/join-agent", opts);
  const text = await res.text();
  let code = null;
  try { code = JSON.parse(text).error?.code; } catch {}
  console.log(name, "->", res.status, code, "| allow:", res.headers.get("allow"), "| len:", text.length);
  return res.status;
}
const IDHDR = { Authorization: "Bearer " + sec, Origin: ORIGIN, "Content-Type": "application/json" };

// wait for the 60s rate bucket from the first pass to expire
await new Promise(r => setTimeout(r, 65000));

await probe("b5-fixed lowercase bearer, garbage token", {
  method: "POST",
  headers: { ...IDHDR, Authorization: "bearer " + sec },
  body: JSON.stringify({ linkToken: "nope", displayName: "F" }),
});
await probe("b23-fixed oversized body (20k token)", {
  method: "POST", headers: IDHDR,
  body: JSON.stringify({ linkToken: "x".repeat(20000), displayName: "F" }),
});
await probe("b24 near-limit body (15k token, valid identity)", {
  method: "POST", headers: IDHDR,
  body: JSON.stringify({ linkToken: "x".repeat(15000), displayName: "F" }),
});
