// Guild-03 fuzz units F1..F15. Usage: node fuzz-unit.mjs F1
// Each unit boots its own server (own port + fixture dir) -> parallel-safe.
import { appendFileSync } from "node:fs";
import { bootFuzzServer, runCases, summarize, evil } from "./fuzzlib.mjs";

const UNIT = process.argv[2];
const MD = new URL("../fuzz.md", import.meta.url).pathname;

const { origin, ownerToken, roomId, close } = await bootFuzzServer();
const R = `/api/rooms/${roomId}`;
const AUTH = { Authorization: `Bearer ${ownerToken}` };
const J = { "Content-Type": "application/json" };

// helper: same hostile case across all evil auth headers
const authSweep = (name, method, path, extra = {}) =>
  evil.auths.map(([label, h]) => ({ name: `${name} [${label}]`, method, path, headers: h, bypass: true, ...extra }));

const builders = {
F1(env) { // feedback-routes
  const p = `${R}/feedback`;
  const good = { agent: { lane: "x" }, endpoint: { method: "POST", path: "/x" },
    attempt: { goal: "g", request: {}, response: { status: 200, body: {} } },
    observed: "o", expected: "e", severity: "bug" };
  return [
    { name: "submit garbage bodies", method: "POST", path: p, headers: AUTH, body: { nope: 1 } },
    ...evil.types.map((t, i) => ({ name: `submit wrong-type body #${i}`, method: "POST", path: p, headers: AUTH, body: t })),
    { name: "submit non-JSON", method: "POST", path: p, headers: AUTH, rawBody: "{not json" },
    { name: "submit oversized", method: "POST", path: p, headers: AUTH, rawBody: JSON.stringify({ ...good, observed: evil.big() }) },
    { name: "submit huge 5MB", method: "POST", path: p, headers: AUTH, rawBody: evil.huge() },
    ...authSweep("submit auth bypass", "POST", p, { body: good }),
    { name: "submit wrong verb PUT", method: "PUT", path: p, headers: AUTH, body: good },
    { name: "read verdict bad id", method: "GET", path: `${p}/fb-../../../etc`, headers: AUTH },
    { name: "read verdict long id", method: "GET", path: `${p}/${evil.longId}`, headers: AUTH },
    { name: "read verdict unicode", method: "GET", path: `${p}/${encodeURIComponent(evil.unicode)}`, headers: AUTH },
    { name: "triage wrong verb GET", method: "GET", path: `${p}/fb-abc/triage`, headers: AUTH },
    { name: "appeal array body", method: "POST", path: `${p}/fb-abc/appeal`, headers: AUTH, body: [1, 2] },
    { name: "notifications HEAD", method: "HEAD", path: `${p}/notifications`, headers: AUTH },
    ...evil.verbs.map(v => ({ name: `list wrong verb ${v}`, method: v, path: p, headers: AUTH })),
  ];
},
F2(env) { // work-claim-routes
  const p = `${R}/work-claims`;
  return [
    { name: "create empty", method: "POST", path: p, headers: AUTH, body: {} },
    { name: "create wrong types", method: "POST", path: p, headers: AUTH, body: { id: 123, title: ["x"] } },
    { name: "create huge note", method: "POST", path: p, headers: AUTH, body: { id: "fz1", note: evil.big(500000) } },
    { name: "create array body", method: "POST", path: p, headers: AUTH, body: [1] },
    { name: "create non-JSON", method: "POST", path: p, headers: AUTH, rawBody: "[broken" },
    ...authSweep("create auth bypass", "POST", p, { body: { id: "fz2" } }),
    { name: "claim bad id traversal", method: "POST", path: `${p}/${evil.traversal}/claim`, headers: AUTH, body: {} },
    { name: "claim long id", method: "POST", path: `${p}/${evil.longId}/claim`, headers: AUTH, body: {} },
    { name: "claim null byte id", method: "POST", path: `${p}/a%00b/claim`, headers: AUTH, body: {} },
    { name: "update bad state type", method: "POST", path: `${p}/nope/update`, headers: AUTH, body: { state: 42 } },
    { name: "release wrong verb", method: "GET", path: `${p}/nope/release`, headers: AUTH },
    { name: "renew negative lease", method: "POST", path: `${p}/nope/renew`, headers: AUTH, body: { leaseHours: -5 } },
    { name: "renew huge lease", method: "POST", path: `${p}/nope/renew`, headers: AUTH, body: { leaseHours: 1e18 } },
    { name: "receipts bad limit", method: "GET", path: `${p}/receipts?limit=abc`, headers: AUTH },
    { name: "receipts evil cursor", method: "GET", path: `${p}/receipts?cursor=${encodeURIComponent("!not-base64!")}`, headers: AUTH },
    { name: "duplicates no q", method: "GET", path: `${p}/duplicates`, headers: AUTH },
    { name: "sweep wrong verb", method: "GET", path: `${p}/sweep`, headers: AUTH },
    { name: "provenance bad id", method: "GET", path: `${p}/${evil.longId}/provenance`, headers: AUTH },
  ];
},
F3(env) { // bounty-escrow-routes
  const p = `${R}/bounties`;
  return [
    { name: "create string amount", method: "POST", path: p, headers: AUTH, body: { title: "t", criteria: "c", amount: "lots", deadline: "tomorrow" } },
    { name: "create negative amount", method: "POST", path: p, headers: AUTH, body: { title: "t", criteria: "c", amount: -50, deadline: "x" } },
    { name: "create huge amount", method: "POST", path: p, headers: AUTH, body: { title: "t", criteria: "c", amount: 1e30, deadline: "x" } },
    { name: "create array", method: "POST", path: p, headers: AUTH, body: [] },
    ...authSweep("create auth bypass", "POST", p, { body: { title: "t", criteria: "c", amount: 1, deadline: "x" } }),
    { name: "sybil-confirm non-owner bypass", method: "POST", path: `${p}/sybil/nonexistent/confirm`, headers: AUTH, body: { reason: "x" }, bypass: false },
    { name: "transfer self huge", method: "POST", path: `${R}/credits/transfer`, headers: AUTH, body: { to: "owner", amount: 1e18 } },
    { name: "transfer wrong types", method: "POST", path: `${R}/credits/transfer`, headers: AUTH, body: { to: 1, amount: "x" } },
    { name: "balances bad identity", method: "GET", path: `${p}/balances/${encodeURIComponent("a/b")}`, headers: AUTH },
    { name: "balances long identity", method: "GET", path: `${p}/balances/${evil.longId}`, headers: AUTH },
    { name: "list bad group", method: "GET", path: `${p}?group=nope`, headers: AUTH },
    { name: "dispute no bond", method: "POST", path: `${p}/nope/dispute`, headers: AUTH, body: { grounds: "x" } },
    { name: "epoch-close wrong verb", method: "GET", path: `${R}/credits/epoch-close`, headers: AUTH },
  ];
},
F4(env) { // matchmaking-routes
  const p = `${R}/matchmaking`;
  return [
    { name: "declare wrong types", method: "POST", path: `${p}/seeker`, headers: AUTH, body: { motives: "x", appetiteMinutes: "lots" } },
    { name: "declare huge", method: "POST", path: `${p}/seeker`, headers: AUTH, body: { motives: [evil.big()], capabilities: [evil.big()] } },
    ...authSweep("declare auth bypass", "POST", p, { body: {} }),
    { name: "match undeclared", method: "POST", path: `${p}/match`, headers: AUTH, body: {} },
    { name: "offer wrong types", method: "POST", path: `${p}/openings`, headers: AUTH, body: { workId: 1, trustFloor: "high" } },
    { name: "decision-answer no lane", method: "POST", path: `${p}/decisions/${evil.longId}/answer`, headers: AUTH, body: { answer: "yes", answeredBy: "owner" } },
    { name: "decision-read traversal", method: "GET", path: `${p}/decisions/${evil.traversal}`, headers: AUTH },
    { name: "decision-open array", method: "POST", path: `${p}/decisions`, headers: AUTH, body: [] },
    ...evil.verbs.map(v => ({ name: `seeker wrong verb ${v}`, method: v, path: `${p}/seeker`, headers: AUTH })),
  ];
},
F5(env) { // inbox-collab-routes
  const p = `${R}/collab`;
  return [
    { name: "assignments bad shape", method: "POST", path: `${p}/assignments`, headers: AUTH, body: { threadId: 1 } },
    ...authSweep("assignments auth bypass", "POST", `${p}/assignments`, { body: { threadId: "t", assignee: "a" } }),
    { name: "approval-decide as agent-kind", method: "POST", path: `${p}/approvals/x/decide`, headers: AUTH, body: { decision: "approve" } },
    { name: "lock-acquire bad ttl", method: "POST", path: `${p}/locks/acquire`, headers: AUTH, body: { threadId: "t", ttlMs: "soon" } },
    { name: "routing-policy bad agent", method: "POST", path: `${p}/routing/policy`, headers: AUTH, body: { agentId: evil.longId, policy: {} } },
    { name: "envelopes huge", method: "POST", path: `${p}/envelopes`, headers: AUTH, body: { to: "a", objective: evil.big(), inputs: {}, authority: {}, expectedOutput: "x", acceptanceTest: "x", termination: "x" } },
    { name: "handoff bad to", method: "POST", path: `${p}/handoffs`, headers: AUTH, body: { threadId: "t", to: { kind: "alien", id: "" } } },
    { name: "notes missing threadId", method: "GET", path: `${p}/notes`, headers: AUTH },
    ...evil.verbs.map(v => ({ name: `envelopes wrong verb ${v}`, method: v, path: `${p}/envelopes`, headers: AUTH })),
  ];
},
F6(env) { // mcp-http: POST /mcp
  const p = "/mcp";
  const rpc = (method, params, id = "1") => ({ jsonrpc: "2.0", id, method, params });
  return [
    { name: "non-JSON body", method: "POST", path: p, rawBody: "{broken", headers: J },
    { name: "empty body", method: "POST", path: p, rawBody: "", headers: J },
    { name: "JSON array batch", method: "POST", path: p, body: [rpc("ping"), rpc("ping")], headers: J },
    { name: "null body", method: "POST", path: p, body: null, headers: J },
    { name: "wrong jsonrpc version", method: "POST", path: p, body: { jsonrpc: "1.0", id: 1, method: "ping" }, headers: J },
    { name: "unknown method", method: "POST", path: p, body: rpc("nope/method"), headers: J },
    { name: "huge id string", method: "POST", path: p, body: rpc("ping", {}, "x".repeat(5000)), headers: J },
    { name: "numeric float id", method: "POST", path: p, body: { jsonrpc: "2.0", id: 1.5, method: "ping" }, headers: J },
    { name: "tools/call unknown tool", method: "POST", path: p, body: rpc("tools/call", { name: "room_nuke_everything", arguments: {} }), headers: J },
    { name: "tools/call hosted tool anon", method: "POST", path: p, body: rpc("tools/call", { name: "room_post_message", arguments: { roomId: "x", body: "hi" } }), headers: J, bypass: true },
    { name: "tools/call bad args type", method: "POST", path: p, body: rpc("tools/call", { name: "room_join_packet", arguments: [1, 2] }), headers: J },
    { name: "tools/call huge args", method: "POST", path: p, body: rpc("tools/call", { name: "room_join_packet", arguments: { x: evil.big(300000) } }), headers: J },
    { name: "initialize bad shape", method: "POST", path: p, body: rpc("initialize", { protocolVersion: 42 }), headers: J },
    { name: "garbage bearer on mcp", method: "POST", path: p, body: rpc("tools/list"), headers: { ...J, Authorization: "Bearer nope" }, bypass: true },
    { name: "PUT /mcp", method: "PUT", path: p, headers: J },
    { name: "DELETE /mcp", method: "DELETE", path: p, headers: J },
    { name: "GET /mcp join doc", method: "GET", path: p, headers: J },
    { name: "HEAD /mcp", method: "HEAD", path: p, headers: J },
    { name: "5MB JSON bomb", method: "POST", path: p, rawBody: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "x", arguments: { pad: evil.big(5 * 1024 * 1024) } } }), headers: J },
  ];
},
F7(env) { // mcp discovery surfaces
  return [
    { name: "GET server card", method: "GET", path: "/.well-known/mcp-server-card.json" },
    { name: "GET /mcp json accept", method: "GET", path: "/mcp", headers: { Accept: "application/json" } },
    { name: "GET /mcp text accept", method: "GET", path: "/mcp", headers: { Accept: "text/plain" } },
    { name: "GET /mcp evil accept", method: "GET", path: "/mcp", headers: { Accept: evil.big(2000) } },
    { name: "OPTIONS /mcp", method: "OPTIONS", path: "/mcp" },
    { name: "GET /join.txt", method: "GET", path: "/join.txt" },
    { name: "GET /llms.txt", method: "GET", path: "/llms.txt" },
    ...authSweep("server card auth sweep", "GET", "/.well-known/mcp-server-card.json"),
  ];
},
F8(env) { // agent-plugin-routes
  return [
    { name: "issue key no auth", method: "POST", path: "/api/agent-keys", body: { scopes: ["directory:publish"] }, bypass: true },
    { name: "issue key garbage auth", method: "POST", path: "/api/agent-keys", headers: { Authorization: "Bearer xyz" }, body: { scopes: ["directory:publish"] }, bypass: true },
    { name: "issue key bad scopes type", method: "POST", path: "/api/agent-keys", headers: AUTH, body: { scopes: "all" } },
    { name: "issue key empty scopes", method: "POST", path: "/api/agent-keys", headers: AUTH, body: { scopes: [] } },
    { name: "issue key huge scopes", method: "POST", path: "/api/agent-keys", headers: AUTH, body: { scopes: [evil.big(5000)] } },
    { name: "rotate no confirm", method: "POST", path: "/api/agent-keys/rak_abc/rotate", headers: AUTH, body: {} },
    { name: "revoke no confirm", method: "POST", path: "/api/agent-keys/rak_abc/revoke", headers: AUTH, body: {} },
    { name: "key action bad id", method: "POST", path: `/api/agent-keys/${evil.longId}/rotate`, headers: AUTH, body: { confirm: true } },
    { name: "publish card bad sig", method: "POST", path: "/api/agent-directory/cards", headers: AUTH, body: { agentId: "a", card: {}, publicKey: "x", signature: "y" } },
    { name: "publish card huge", method: "POST", path: "/api/agent-directory/cards", headers: AUTH, body: { agentId: "a", card: { bio: evil.big() }, publicKey: "x", signature: "y" } },
    { name: "directory read traversal", method: "GET", path: `/api/agent-directory/cards/${evil.traversal}` },
    { name: "manifest", method: "GET", path: "/api/agent-manifest" },
    ...evil.verbs.map(v => ({ name: `agent-keys wrong verb ${v}`, method: v, path: "/api/agent-keys", headers: AUTH })),
  ];
},
F9(env) { // small route modules: next-actions, operator, legal, supervision
  return [
    ...authSweep("next-actions list bypass", "GET", `${R}/next-actions`),
    { name: "next-actions bad limit", method: "GET", path: `${R}/next-actions?limit=abc`, headers: AUTH },
    { name: "next-actions dismiss bad body", method: "POST", path: `${R}/next-actions-dismiss`, headers: AUTH, body: [1] },
    ...authSweep("operator status bypass", "GET", "/api/operator/status"),
    { name: "operator status garbage token", method: "GET", path: "/api/operator/status", headers: { Authorization: "Bearer wrong" }, bypass: true },
    { name: "operator bad path", method: "GET", path: "/api/operator/../../etc", headers: AUTH },
    { name: "legal report no pow", method: "POST", path: "/api/reports/public", body: { kind: "bug", target: "x", body: "y", bucket: "b", nonce: "n" } },
    { name: "legal report extra fields", method: "POST", path: "/api/reports/public", body: { kind: "b", target: "t", body: "x", bucket: "k", nonce: "n", evil: 1 } },
    { name: "legal report huge", method: "POST", path: "/api/reports/public", body: { kind: "b", target: "t", body: evil.big(), bucket: "k", nonce: "n" } },
    { name: "legal terms no cookie", method: "POST", path: "/api/account/terms", body: { version: "1" }, bypass: true },
    { name: "legal unpublish no cookie", method: "POST", path: "/api/operator/unpublish", body: { kind: "x", id: "y" }, bypass: true },
    { name: "legal page wrong verb", method: "POST", path: "/terms", body: {} },
    { name: "supervision unwired", method: "GET", path: `${R}/supervision/cards`, headers: AUTH },
  ];
},
F10(env) { // routes/auth.mjs
  return [
    { name: "password login bad creds", method: "POST", path: "/api/auth/password/login", body: { email: "a@b.c", password: "wrong" } },
    { name: "password login sqli", method: "POST", path: "/api/auth/password/login", body: { email: "' OR '1'='1", password: "' OR '1'='1" } },
    { name: "password login wrong types", method: "POST", path: "/api/auth/password/login", body: { email: 1, password: [] } },
    { name: "password login huge", method: "POST", path: "/api/auth/password/login", body: { email: evil.big(10000), password: evil.big(10000) } },
    { name: "signup bad email", method: "POST", path: "/api/auth/password/signup", body: { email: "not-an-email", password: "x".repeat(8) } },
    { name: "reset request garbage", method: "POST", path: "/api/auth/password/reset/request", body: { email: evil.unicode } },
    { name: "reset consume bad token", method: "POST", path: "/api/auth/password/reset/consume", body: { token: evil.longId, password: "newpass1" } },
    { name: "magic request bad", method: "POST", path: "/api/auth/magic/request", body: { email: 42 } },
    { name: "magic consume bad", method: "POST", path: "/api/auth/magic/consume", body: { token: "../.." } },
    { name: "desktop start", method: "POST", path: "/api/auth/desktop/start", body: {} },
    { name: "passkey options bad", method: "POST", path: "/api/auth/passkey/register/options", body: { nope: true } },
    ...evil.verbs.map(v => ({ name: `login wrong verb ${v}`, method: v, path: "/api/auth/password/login", body: {} })),
  ];
},
F11(env) { // routes/agents.mjs + dispatch.mjs
  return [
    ...authSweep("agents overview bypass", "GET", `${R}/agents/overview`),
    { name: "agents overview bad room", method: "GET", path: `/api/rooms/${evil.traversal}/agents/overview`, headers: AUTH },
    { name: "dispatch bad body", method: "POST", path: `${R}/dispatch`, headers: AUTH, body: { nope: [] } },
    { name: "dispatch huge", method: "POST", path: `${R}/dispatch`, headers: AUTH, body: { command: evil.big(200000) } },
    ...evil.verbs.map(v => ({ name: `dispatch wrong verb ${v}`, method: v, path: `${R}/dispatch`, headers: AUTH })),
  ];
},
F12(env) { // routes/work-claims.mjs + member-permissions.mjs (authz)
  return [
    ...authSweep("work-claims legacy bypass", "GET", `${R}/work-claims`),
    { name: "member-permissions bad member", method: "GET", path: `${R}/member-permissions/${evil.longId}`, headers: AUTH },
    { name: "member-permissions traversal", method: "GET", path: `${R}/member-permissions/${evil.traversal}`, headers: AUTH },
    { name: "work-claims legacy POST bypass", method: "POST", path: `${R}/work-claims`, headers: {}, body: { id: "zz" }, bypass: true },
  ];
},
F13(env) { // routes/inbox.mjs + code-drops.mjs
  return [
    ...authSweep("inbox bypass", "GET", "/api/inbox"),
    { name: "inbox search evil q", method: "GET", path: `/api/inbox/search?q=${encodeURIComponent(evil.unicode)}`, headers: AUTH },
    { name: "inbox threads bad cursor", method: "GET", path: "/api/inbox/threads?cursor=!!!", headers: AUTH },
    { name: "code drop bad id", method: "GET", path: `${R}/code/${evil.longId}`, headers: AUTH },
    { name: "code drop raw traversal", method: "GET", path: `${R}/code/${evil.traversal}/raw`, headers: AUTH },
    { name: "code drop checks bad", method: "GET", path: `${R}/code/..%2f..%2fsecret/checks`, headers: AUTH },
    ...evil.verbs.map(v => ({ name: `inbox wrong verb ${v}`, method: v, path: "/api/inbox", headers: AUTH })),
  ];
},
F14(env) { // routes/spend-grants.mjs + spend-pricing.mjs
  return [
    ...authSweep("spend grants bypass", "GET", `${R}/spend-grants`),
    { name: "spend grant negative", method: "POST", path: `${R}/spend-grants`, headers: AUTH, body: { amount: -100, to: "x" } },
    { name: "spend grant overflow", method: "POST", path: `${R}/spend-grants`, headers: AUTH, body: { amount: 1e21, to: "x" } },
    { name: "spend grant wrong types", method: "POST", path: `${R}/spend-grants`, headers: AUTH, body: { amount: "lots", to: ["x"] } },
    { name: "spend pricing bad", method: "GET", path: `${R}/spend-pricing?tool=${evil.longId}`, headers: AUTH },
    ...evil.verbs.map(v => ({ name: `spend-grants wrong verb ${v}`, method: v, path: `${R}/spend-grants`, headers: AUTH })),
  ];
},
F15(env) { // routes/desktop-auth + agent-connect + misc small routes
  return [
    { name: "desktop callback bad code", method: "GET", path: `/api/auth/desktop/callback?code=${evil.longId}` },
    { name: "desktop session bad", method: "GET", path: "/api/auth/desktop/session", headers: { Cookie: "x=".concat(evil.big(3000)) } },
    { name: "agent-connect bad", method: "POST", path: `${R}/agent-connect`, headers: AUTH, body: { token: "../.." } },
    ...authSweep("squads bypass", "GET", `${R}/squads`),
    { name: "squads create bad", method: "POST", path: `${R}/squads`, headers: AUTH, body: { name: evil.big(5000) } },
    ...authSweep("wake-status bypass", "GET", "/api/wake-status"),
    { name: "table bad", method: "GET", path: `${R}/table?view=${evil.unicode}`, headers: AUTH },
    { name: "typing bad", method: "POST", path: `${R}/typing`, headers: AUTH, body: { active: "yes" } },
    { name: "wants-work bad", method: "POST", path: `${R}/wants-work`, headers: AUTH, body: [] },
    { name: "demo evil", method: "GET", path: "/api/demo?x=".concat(evil.big(3000)) },
    { name: "human-push bad", method: "POST", path: `${R}/human-push`, headers: AUTH, body: { subscription: "x" } },
    { name: "record-rails bad", method: "GET", path: `${R}/record-rails/${evil.traversal}`, headers: AUTH },
    { name: "room-assistant bad", method: "POST", path: `${R}/room-assistant`, headers: AUTH, body: { action: evil.big(100000) } },
  ];
},
};

if (!builders[UNIT]) { console.error("unknown unit", UNIT); process.exit(2); }
appendFileSync(MD, `\n# fuzz ${UNIT} — ${new Date().toISOString()}\n`);
const cases = builders[UNIT]({ origin, ownerToken, roomId });
console.log(`${UNIT}: firing ${cases.length} hostile inputs against ${origin}`);
const results = await runCases(origin, cases);
const s = summarize(UNIT, results, MD);
console.log(`${UNIT} done:`, JSON.stringify(s));
await close();
