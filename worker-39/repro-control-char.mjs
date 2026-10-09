// Minimal repro: POST /api/share-links/join-agent accepts C0 control chars in
// displayName on a FIRST join and stores the name, while POST /join and
// POST /api/agent-identities reject them with 422 (RC-2026-09-19-086).
import { randomBytes, randomUUID } from "node:crypto";
const BASE = "http://127.0.0.1:45139";
const ORIGIN = BASE;
async function req(method, path, { body, headers = {}, bearer } = {}) {
  const h = { "Content-Type": "application/json", ...headers, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
// owner + room + share link
const join = await req("POST", "/join", { body: { displayName: "ctrlowner" }, headers: { Origin: ORIGIN } });
const owner = JSON.parse(join.text);
const linkToken = randomBytes(32).toString("base64url");
const mk = await req("POST", `/api/rooms/${encodeURIComponent(owner.roomId)}/share-links`, {
  body: { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600e3, maxJoins: 5, expectedMemberRevision: 0 },
  bearer: owner.identitySecret, headers: { Origin: ORIGIN },
});
console.log("link create:", mk.status);
// fresh agent identity
const ident = await req("POST", "/api/agent-identities", { body: { displayName: "ctrlagent" }, headers: { Origin: ORIGIN } });
const agent = JSON.parse(ident.text);
// control evidence: /api/agent-identities rejects C0
const badMint = await req("POST", "/api/agent-identities", { body: { displayName: "evil" }, headers: { Origin: ORIGIN } });
console.log("mint with C0:", badMint.status, badMint.text.slice(0, 100));
// shard route: join-agent with C0 control char, FIRST join for this identity
const j = await req("POST", "/api/share-links/join-agent", {
  body: { linkToken, displayName: "evil-agent" }, bearer: agent.secret, headers: { Origin: ORIGIN },
});
console.log("join-agent with C0:", j.status, j.text.slice(0, 200));
// verify the name was stored: read room members as owner
const snap = await req("GET", `/api/rooms/${encodeURIComponent(owner.roomId)}?view=work`, { bearer: owner.identitySecret, headers: { Origin: ORIGIN } });
const members = Object.values(JSON.parse(snap.text).state?.members ?? {});
const found = members.find(m => m.identityId === agent.identityId);
console.log("stored displayName codepoints:", [...(found?.displayName ?? "")].map(c => c.codePointAt(0).toString(16)));
