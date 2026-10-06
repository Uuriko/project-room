#!/usr/bin/env node
// Authorization / IDOR matrix for Project Room's agent HTTP surface.
// Builds a throwaway room with one identity per role, then runs every action
// as every role and compares the outcome with the expected policy.
//   roles: owner, collaborator (profile collaborate), chatter (profile chat),
//          linkguest (share-link join-agent), outsider (identity, no membership),
//          anonymous (no credential), revoked (joined, then revoked its secret)
//   outcome classes: allow (2xx) | deny (401/403/404) | refused (422/409 = reached
//   validation; counts as a FAIL when the policy says deny, because the check
//   order leaked past authorization) | error (5xx/transport)
// Usage: node scripts/qa2/authz-matrix.mjs --origin http://127.0.0.1:4173 [--json out.json] [--keep]
// Writes only to the room it creates (qa2-authz-*), archives it at the end unless --keep.
import { argv, exit } from "node:process";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQaClient } from "./lib/client.mjs";

const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const origin = arg("origin", "http://127.0.0.1:4173");
const UA = "project-room-qa2-authz/1";
const client = createQaClient({ origin, userAgent: UA });
const stamp = Date.now().toString(36);

async function req(method, path, { token, body } = {}) {
  return client.request(method, path, { token, body, accept: "application/json" });
}
const must = (r, what) => { if (r.status < 200 || r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
const recovery = join(tmpdir(), `qa2-authz-${stamp}.json`); // secrets for manual cleanup if the run dies; 0600, deleted on success
const minted = [];
// W3-F9: atomic write — a torn file defeats the recovery purpose.
const remember = extra => {
  writeFileSync(`${recovery}.tmp`, JSON.stringify({ origin, minted, ...extra }), { mode: 0o600 });
  renameSync(`${recovery}.tmp`, recovery);
};
const mint = async name => { const m = must(await req("POST", "/api/agent-identities", { body: { displayName: name } }), `mint ${name}`); minted.push({ identityId: m.identityId, secret: m.secret }); remember({}); return m; };
const cmd = (type, data) => ({ id: randomUUID(), type, data });

// ---------- setup ----------
const T = {};
const owner = await mint(`qa2-authz-owner-${stamp}`); T.owner = owner.secret;
const room = must(await req("POST", "/api/agent-rooms", { token: T.owner, body: { title: `qa2-authz-${stamp}`, purpose: "QA2 authz matrix throwaway room" } }), "create room").roomId;
const R = `/api/rooms/${encodeURIComponent(room)}`;
remember({ room });
let hook = null;
async function cleanup() {
  if (hook) await req("DELETE", `/api/agent-webhooks/${hook.subscriptionId}`, { token: T.owner });
  if (argv.includes("--keep")) return;
  const a = await req("POST", `${R}/commands`, { token: T.owner, body: cmd("room.archived", {}) });
  console.error(`archive ${room}: HTTP ${a.status}${a.status >= 300 ? " " + a.text.slice(0, 160) : ""}`);
  for (const m of minted) await req("POST", `/api/agent-identities/${m.identityId}/revoke`, { token: m.secret, body: { confirm: true } });
  rmSync(recovery, { force: true });
}
process.on("uncaughtException", async e => { console.error(String(e)); await cleanup().catch(() => {}); exit(2); });
const ids = { owner: owner.identityId };
for (const [role, profile] of [["collaborator", "collaborate"], ["chatter", "chat"], ["revoked", "chat"]]) {
  const who = await mint(`qa2-authz-${role}-${stamp}`); T[role] = who.secret; ids[role] = who.identityId;
  const inv = must(await req("POST", `${R}/agent-invites`, { token: T.owner, body: { profile, displayName: `qa2-authz-${role}` } }), `invite ${role}`);
  must(await req("POST", "/api/agent-invites/redeem", { token: T[role], body: { code: inv.code, displayName: `qa2-authz-${role}` } }), `redeem ${role}`);
}
const out = await mint(`qa2-authz-outsider-${stamp}`); T.outsider = out.secret; ids.outsider = out.identityId;
// share-link guest (owner-capability bearer exemption); member revision probed 0..5
let linkToken = null;
for (let rev = 0; rev <= 5 && !linkToken; rev++) {
  const lt = randomBytes(32).toString("base64url").slice(0, 43);
  const r = await req("POST", `${R}/share-links`, { token: T.owner, body: { requestId: randomUUID(), linkToken: lt, expiresAt: Date.now() + 3600e3, maxJoins: 2, expectedMemberRevision: rev } });
  if (r.status === 201 || r.status === 200) linkToken = lt;
  else if (r.status !== 409) { console.error(`share-link create: HTTP ${r.status} ${r.text.slice(0, 160)}`); break; }
}
if (linkToken) {
  const g = await mint(`qa2-authz-linkguest-${stamp}`); T.linkguest = g.secret; ids.linkguest = g.identityId;
  const j = await req("POST", "/api/share-links/join-agent", { token: T.linkguest, body: { linkToken, displayName: "qa2-authz-linkguest" } });
  if (j.status >= 300) { console.error(`join-agent: HTTP ${j.status} ${j.text.slice(0, 200)}`); delete T.linkguest; }
}
// revoke "revoked"
must(await req("POST", `/api/agent-identities/${ids.revoked}/revoke`, { token: T.revoked, body: { confirm: true } }), "revoke");
T.anonymous = null;

// fixtures owned by others
const ownerMsg = randomUUID();
must(await req("POST", `${R}/commands`, { token: T.owner, body: cmd("message.posted", { messageId: ownerMsg, body: "qa2 owner message" }) }), "owner msg");
must(await req("POST", `${R}/work-claims`, { token: T.owner, body: { id: "qa2-held", title: "held by collaborator" } }), "claim create");
must(await req("POST", `${R}/work-claims/qa2-held/claim`, { token: T.collaborator, body: { note: "mine", leaseHours: 1 } }), "collab claims");
must(await req("POST", `${R}/work-claims`, { token: T.owner, body: { id: "qa2-release", title: "owner may release" } }), "release fixture");
must(await req("POST", `${R}/work-claims/qa2-release/claim`, { token: T.collaborator, body: { note: "mine", leaseHours: 1 } }), "release fixture claim");
// a bonded DM between owner and collaborator, which nobody else may read
const bond = must(await req("POST", `${R}/commands`, { token: T.owner, body: cmd("bond.propose", { to: ids.collaborator }) }), "bond");
must(await req("POST", `${R}/commands`, { token: T.collaborator, body: cmd("bond.accept", { bondId: bond.event.data.bondId }) }), "bond accept");
const SECRET_DM = `qa2-private-dm-${stamp}`;
must(await req("POST", `${R}/commands`, { token: T.owner, body: cmd("dm.posted", { messageId: randomUUID(), to: ids.collaborator, body: SECRET_DM }) }), "dm");
hook = must(await req("POST", "/api/agent-webhooks", { token: T.owner, body: { url: "https://example.com/qa2-authz", events: ["bond.proposed"] } }), "hook");

// ---------- actions ----------
// policy: roles allowed; everyone else must be denied
const MEMBERS = ["owner", "collaborator", "chatter", "linkguest"];
const A = [
  ["read events", MEMBERS, t => req("GET", `${R}/events?limit=5`, { token: t })],
  ["read activation-pack", MEMBERS, t => req("GET", `${R}/activation-pack`, { token: t })],
  ["post message", MEMBERS, t => req("POST", `${R}/commands`, { token: t, body: cmd("message.posted", { messageId: randomUUID(), body: "qa2 authz post" }) })],
  ["export room log", ["owner"], t => req("GET", `${R}/export`, { token: t })],
  ["list work claims", MEMBERS, t => req("GET", `${R}/work-claims`, { token: t })],
  ["create work claim", ["owner", "collaborator"], t => req("POST", `${R}/work-claims`, { token: t, body: { id: `qa2-c-${randomUUID().slice(0, 8)}`, title: "x" } })],
  ["steal claim held by collaborator", [], t => req("POST", `${R}/work-claims/qa2-held/claim`, { token: t, body: { note: "steal" } }), { okStatuses: [409] }],
  ["update claim held by collaborator", ["collaborator"], t => req("POST", `${R}/work-claims/qa2-held/update`, { token: t, body: { note: "touch" } })],
  ["reassign claim held by collaborator", ["owner", "collaborator"], t => req("POST", `${R}/work-claims/qa2-held/reassign`, { token: t, body: { newOwner: ids.collaborator, note: "keep" } })],
  ["release claim held by collaborator", ["owner", "collaborator"], t => req("POST", `${R}/work-claims/${t === T.owner ? "qa2-release" : "qa2-held"}/release`, { token: t, body: { note: "drop" } })],
  ["mint agent invite", ["owner"], t => req("POST", `${R}/agent-invites`, { token: t, body: { profile: "chat" } })],
  ["list agent invites", ["owner"], t => req("GET", `${R}/agent-invites`, { token: t })],
  ["edit owner's message", ["owner"], t => req("POST", `${R}/commands`, { token: t, body: cmd("message.edited", { messageId: ownerMsg, body: "qa2 edited", expectedMessageRevision: 0 }) }), { denyAs422: "command_rejected", once: true }],
  ["read diagnostics", ["owner"], t => req("GET", `${R}/diagnostics`, { token: t })],
  ["list webhooks shows owner's sub", ["owner"], async t => { const r = await req("GET", "/api/agent-webhooks", { token: t }); return { ...r, status: r.status === 200 ? (r.text.includes(hook.subscriptionId) ? 200 : 403) : r.status }; }],
  ["delete owner's webhook (non-owner)", [], t => t === T.owner ? Promise.resolve({ status: 404 }) : req("DELETE", `/api/agent-webhooks/${hook.subscriptionId}`, { token: t })],
  ["owner-collab DM readable in events", ["owner", "collaborator"], async t => { const r = await req("GET", `${R}/events?limit=100`, { token: t }); return { ...r, status: r.status === 200 && r.text.includes(SECRET_DM) ? 200 : (r.status === 200 ? 403 : r.status) }; }],
  ["owner-collab DM readable in export", ["owner"], async t => { const r = await req("GET", `${R}/export`, { token: t }); return { ...r, status: r.status === 200 && r.text.includes(SECRET_DM) ? 200 : (r.status === 200 ? 403 : r.status) }; }],
  ["owner-collab DM readable via search", ["owner", "collaborator"], async t => { const r = await req("GET", `${R}/search?q=private`, { token: t }); const hit = (r.json?.messages || []).some(m => JSON.stringify(m).includes(SECRET_DM)); return { ...r, status: r.status === 200 ? (hit ? 200 : 403) : r.status }; }, { optional: true }],
  ["needs-me leaks other rooms", [], async t => { const r = await req("GET", "/api/needs-me", { token: t }); return { ...r, status: r.status === 200 && r.text.includes(SECRET_DM) && t !== T.collaborator && t !== T.owner ? 200 : 403 }; }],
];

const roles = ["owner", "collaborator", "chatter", "linkguest", "outsider", "anonymous", "revoked"].filter(r => r in T);
const rows = [];
for (const [name, allowed, run, opts = {}] of A) {
  for (const role of roles) {
    if (opts.once && allowed.includes(role) && rows.some(x => x.action === name && x.outcome === "allow")) { rows.push({ action: name, role, expected: "allow", outcome: "skip", status: "-" }); continue; }
    const r = await run(T[role]);
    const s = r.status;
    let outcome = s >= 200 && s < 300 ? "allow" : [401, 403, 404].includes(s) || (opts.okStatuses || []).includes(s) ? "deny" : [409, 422, 400, 405].includes(s) ? "refused" : "error";
    if (outcome === "refused" && opts.denyAs422 && r.json?.error?.code === opts.denyAs422 && !allowed.includes(role)) outcome = "deny";
    const expected = allowed.includes(role) ? "allow" : "deny";
    let pass = outcome === expected || Boolean(expected === "allow" && opts.optional && outcome !== "error");
    const known = !pass && (opts.known || []).includes(role) ? opts.knownWhy : null;
    if (known) pass = true;
    rows.push({ action: name, role, expected, outcome, status: s, pass, known, code: r.json?.error?.code });
  }
}
// cleanup
await cleanup();
// report
const fails = rows.filter(r => r.pass === false);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("action", 40) + roles.map(r => pad(r, 13)).join(""));
for (const [name] of A) console.log(pad(name, 40) + roles.map(role => { const x = rows.find(r => r.action === name && r.role === role); return pad(x.outcome === "skip" ? "skip" : `${x.known ? "~" : x.pass ? "" : "!!"}${x.outcome}:${x.status}`, 13); }).join(""));
console.log(`\n${rows.length - fails.length - rows.filter(r => r.outcome === "skip").length}/${rows.length - rows.filter(r => r.outcome === "skip").length} cells match policy on ${origin} (room ${room})`);
for (const k of rows.filter(r => r.known)) console.log(`KNOWN ${k.action} as ${k.role}: ${k.known}`);
for (const f of fails) console.log(`FAIL ${f.action} as ${f.role}: expected ${f.expected}, got ${f.outcome} ${f.status} ${f.code || ""}`);
const jsonOut = arg("json"); if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ origin, room, at: new Date().toISOString(), roles, rows }, null, 2));
exit(fails.length ? 1 : 0);
