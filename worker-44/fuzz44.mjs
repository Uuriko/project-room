// WAVE-2000 GUILD-02 worker-44 fuzz for shard routes:
//   idx 43: POST /api/rooms/{roomId}/signoff-loops/{recordId}/submit
//   idx 93: PUT  /api/rooms/{roomId}/members/me/wants-work
import net from "node:net";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

process.env.TMPDIR = "/home/hatch/workspace/pr-wave2000-guild-02/.tmp";
const HEX64 = "a".repeat(64);
const store = new RoomStore(":memory:");
store.initialize(initialRoom("commons"));
const ownerKey = store.issueAccessKey("commons", "owner");
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const port = server.address().port;

async function enroll(name) {
  const identity = store.identities.create(name);
  const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId, displayName: name,
    permissions: ["accept_work", "complete_work"]
  });
  const key = store.issueAccessKey("commons", memberId);
  return { memberId, key };
}
const agents = [];
for (let i = 0; i < 20; i++) agents.push(await enroll(`Fuzz Worker 44 Agent ${i}`));
const candidate = await enroll("Cand44"); // memberId == 'cand44'
let agentCursor = 0;
const nextAgent = () => agents[(agentCursor++) % agents.length];

// seed signoff data
const now = Date.now();
store.db.prepare("INSERT INTO buyer_signoff_loops VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("fuzzloop1", "commons", "trial-1", null, agents[0].memberId, "open", 0, 3, "[]", now, now);
store.db.prepare("INSERT INTO buyer_signoff_loops VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("fuzzloop2", "commons", "trial-2", null, agents[1].memberId, "open", 0, 3, "[]", now, now);
store.db.prepare("INSERT INTO room_trial_tasks VALUES (?,?,?)")
  .run("commons", "trial-1", JSON.stringify({ id: "trial-1", state: "submitted", buyerId: agents[0].memberId, candidateId: "cand44" }));
store.db.prepare("INSERT INTO room_trial_tasks VALUES (?,?,?)")
  .run("commons", "trial-2", JSON.stringify({ id: "trial-2", state: "submitted", buyerId: agents[1].memberId, candidateId: "cand44" }));

const results = [];
const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");

async function fetchCase(route, name, method, path, opts = {}) {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
    const headers = { ...(opts.token === undefined ? { authorization: `Bearer ${nextAgent().key}` } : (opts.token ? { authorization: `Bearer ${opts.token}` } : {})), ...(opts.headers ?? {}) };
    const r = await fetch(origin + path, {
      method, headers, redirect: "manual", signal: ctl.signal,
      body: opts.rawBody !== undefined ? opts.rawBody : (opts.body === undefined ? undefined : (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body))),
      ...(opts.noContentType ? {} : (opts.body !== undefined || opts.rawBody !== undefined ? {} : {})),
    });
    clearTimeout(timer);
    // default content-type: run through the same wiring as the sanity harness
    const text = await r.text().catch(() => "");
    return { route, name, method, path: path.slice(0, 120), status: r.status, ms: Date.now() - started, head: text.slice(0, 220) };
  } catch (e) {
    return { route, name, method, path: path.slice(0, 120), status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", ms: Date.now() - started, head: String(e.message).slice(0, 200) };
  }
}
// JSON body helper that always sets content-type unless overridden
async function j(route, name, method, path, body, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  return fetchCase(route, name, method, path, { ...opts, body, headers });
}

function rawRequest(payload, timeoutMs = 5000) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const finish = (result) => { if (!done) { done = true; sock.destroy(); resolve(result); } };
    const timer = setTimeout(() => finish({ status: "TIMEOUT", head: data.slice(0, 200) }), timeoutMs);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish({ status: "CLOSED", head: data.slice(0, 200) }); });
    sock.on("error", e => { clearTimeout(timer); finish({ status: "SOCKET-ERROR", head: e.message.slice(0, 200) }); });
    setTimeout(() => { if (!done && data) { clearTimeout(timer); finish({ status: "RESP", head: data.slice(0, 200) }); } }, 2000);
  });
}

async function healthOk() {
  try {
    const r = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(3000) });
    return r.status === 200;
  } catch { return false; }
}

const R1 = "signoff-submit";
const R2 = "wants-work";
const S = (loop, extra = "") => `/api/rooms/commons/signoff-loops/${loop}/submit${extra}`;
const W = (extra = "") => `/api/rooms/commons/members/me/wants-work${extra}`;
let reqSeq = 0;
const goodSubmit = (over = {}) => ({ requestId: `req44-${reqSeq++}`, deliverableRef: "ref-1", sha256: HEX64, summary: "looks good", candidateId: "cand44", ...over });

// ============ wants-work PUT cases ============
for (const [name, body] of [
  ["ww:valid-empty", {}],
  ["ww:valid-labels", { labels: ["Docs", "Go"] }],
  ["ww:labels-not-array", { labels: "docs" }],
  ["ww:labels-17", { labels: Array.from({ length: 17 }, (_, i) => `l${i}`) }],
  ["ww:label-41chars", { labels: ["x".repeat(41)] }],
  ["ww:label-badchars", { labels: ["a/b", "A", "", "  ", "../x"] }],
  ["ww:labels-nonstring", { labels: [123, true, null] }],
  ["ww:caps-invalid", { capabilities: ["bogus"] }],
  ["ww:caps-notarray", { capabilities: "work" }],
  ["ww:extra-key", { labels: [], capabilities: [], foo: 1 }],
  ["ww:body-null", null],
  ["ww:body-array", [1, 2]],
  ["ww:body-string", "hello"],
  ["ww:body-number", 42],
  ["ww:body-deepnest", '{"a":'.repeat(400) + "1" + "}".repeat(400)],
  ["ww:body-proto", '{"__proto__":{"x":1}}'],
  ["ww:body-oversize-20k", JSON.stringify({ labels: ["x".repeat(20 * 1024)] })],
  ["ww:body-oversize-100k", JSON.stringify({ a: "x".repeat(100 * 1024) })],
  ["ww:body-1mb", JSON.stringify({ a: "x".repeat(1024 * 1024) })],
  ["ww:body-bom", "\ufeff{\"labels\":[]}"],
  ["ww:body-dup", '{"labels":["a"],"labels":["b"]}'],
  ["ww:body-unicode-label", { labels: ["🪔"] }],
  ["ww:labels-null", { labels: null }],
  ["ww:caps-null", { capabilities: null }],
  ["ww:labels-dup", { labels: ["docs", "DOCS", " docs "] }],
  ["ww:labels-16ok", { labels: Array.from({ length: 16 }, (_, i) => `l${i}`) }],
]) results.push(await j(R2, name, "PUT", W(), body));

for (const [name, body, extra] of [
  ["ww:truncated", '{"labels":', null],
  ["ww:bare-brace", "{", null],
  ["ww:empty", "", null],
  ["ww:whitespace", "   \n\t ", null],
]) results.push(await j(R2, name, "PUT", W(), body, extra ?? {}));
results.push(await fetchCase(R2, "ww:invalid-utf8", "PUT", W(), {
  rawBody: Buffer.concat([Buffer.from('{"labels":["'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('"]}')]),
  headers: { "Content-Type": "application/json" }
}));
results.push(await j(R2, "ww:ct-text-plain", "PUT", W(), { labels: ["a"] }, { headers: { "Content-Type": "text/plain" } }));
results.push(await fetchCase(R2, "ww:ct-none", "PUT", W(), { body: JSON.stringify({ labels: ["a"] }), headers: {} }));
results.push(await fetchCase(R2, "ww:ct-urlencoded", "PUT", W(), { body: "labels=a&b=2", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
results.push(await fetchCase(R2, "ww:ct-multipart", "PUT", W(), { body: "--zzz\r\nContent-Disposition: form-data; name=\"labels\"\r\n\r\na\r\n--zzz--\r\n", headers: { "Content-Type": "multipart/form-data; boundary=zzz" } }));
results.push(await j(R2, "ww:human-put", "PUT", W(), { labels: ["a"] }, { token: ownerKey }));
results.push(await j(R2, "ww:no-auth", "PUT", W(), { labels: ["a"] }, { token: null }));
results.push(await j(R2, "ww:bad-bearer", "PUT", W(), { labels: ["a"] }, { token: "garbage-token-xyz" }));
results.push(await fetchCase(R2, "ww:get-ok", "GET", W()));
results.push(await fetchCase(R2, "ww:delete-ok", "DELETE", W()));
for (const m of ["POST", "PATCH", "OPTIONS", "TRACE"]) results.push(await fetchCase(R2, `ww:method-${m}`, m, W(), { headers: { "Content-Type": "application/json" }, body: '{"labels":[]}' }));
results.push(await fetchCase(R2, "ww:trailing-slash", "PUT", W("/"), { headers: { "Content-Type": "application/json" }, body: "{}" }));
results.push(await fetchCase(R2, "ww:huge-query", "PUT", W("?q=" + "y".repeat(8192)), { headers: { "Content-Type": "application/json" }, body: "{}" }));
results.push(await fetchCase(R2, "ww:query-nullbyte", "PUT", W("?a=%00"), { headers: { "Content-Type": "application/json" }, body: "{}" }));
results.push(await j(R2, "ww:big-header", "PUT", W(), { labels: ["a"] }, { headers: { "X-Big": "z".repeat(16384) } }));
results.push(await fetchCase(R2, "ww:other-member", "PUT", "/api/rooms/commons/members/other/wants-work", { headers: { "Content-Type": "application/json" }, body: "{}" }));
// rate burst
for (let i = 0; i < 70; i++) results.push(await j(R2, `ww:burst-${i}`, "PUT", W(), { labels: ["b"] }));

console.log("wants-work batch done, health:", await healthOk());

// ============ signoff submit POST cases ============
const L1 = "fuzzloop1", L2 = "fuzzloop2";
for (const [name, body] of [
  ["ss:valid", goodSubmit()],
  ["ss:missing-summary", goodSubmit({ summary: undefined })],
  ["ss:extra-field", goodSubmit({ extra: 1 })],
  ["ss:body-null", null],
  ["ss:body-array", [1, 2]],
  ["ss:body-string", "hello"],
  ["ss:body-number", 42],
  ["ss:body-deepnest", '{"a":'.repeat(400) + "1" + "}".repeat(400)],
  ["ss:body-proto", '{"__proto__":{"x":1},"requestId":"r1","deliverableRef":"r","sha256":"' + HEX64 + '","summary":"s","candidateId":"cand44"}'],
  ["ss:sha256-upper", goodSubmit({ sha256: "A".repeat(64) })],
  ["ss:sha256-63", goodSubmit({ sha256: "a".repeat(63) })],
  ["ss:sha256-nonhex", goodSubmit({ sha256: "g".repeat(64) })],
  ["ss:sha256-number", goodSubmit({ sha256: 123 })],
  ["ss:ref-empty", goodSubmit({ ref: undefined, deliverableRef: "   " })],
  ["ss:ref-2001", goodSubmit({ deliverableRef: "x".repeat(2001) })],
  ["ss:ref-control", goodSubmit({ deliverableRef: "a\x01b" })],
  ["ss:ref-cred-shaped", goodSubmit({ deliverableRef: "token=abcdef pri_x" })],
  ["ss:candidate-missing", goodSubmit({ candidateId: undefined })],
  ["ss:candidate-mismatch", goodSubmit({ candidateId: "other" })],
  ["ss:candidate-invalid", goodSubmit({ candidateId: "__proto__" })],
  ["ss:requestid-invalid", goodSubmit({ requestId: "../x" })],
  ["ss:requestid-129", goodSubmit({ requestId: "r".repeat(129) })],
  ["ss:body-oversize-20k", JSON.stringify({ a: "x".repeat(20 * 1024) })],
  ["ss:body-oversize-1mb", JSON.stringify({ a: "x".repeat(1024 * 1024) })],
  ["ss:body-bom", "\ufeff" + JSON.stringify(goodSubmit())],
  ["ss:body-dupkeys", '{"requestId":"r1","requestId":"r2","deliverableRef":"r","sha256":"' + HEX64 + '","summary":"s","candidateId":"cand44"}'],
]) results.push(await j(R1, name, "POST", S(L2), body));

for (const [name, body] of [
  ["ss:truncated", '{"a":'],
  ["ss:bare-brace", "{"],
  ["ss:empty", ""],
  ["ss:whitespace", "  \n "],
]) results.push(await j(R1, name, "POST", S(L2), body));
results.push(await fetchCase(R1, "ss:invalid-utf8", "POST", S(L2), {
  rawBody: Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
  headers: { "Content-Type": "application/json" }
}));
results.push(await j(R1, "ss:ct-text-plain", "POST", S(L2), goodSubmit(), { headers: { "Content-Type": "text/plain" } }));
results.push(await fetchCase(R1, "ss:ct-none", "POST", S(L2), { body: JSON.stringify(goodSubmit()), headers: {} }));
results.push(await fetchCase(R1, "ss:ct-urlencoded", "POST", S(L2), { body: "a=1&b=2", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
results.push(await j(R1, "ss:no-auth", "POST", S(L2), goodSubmit(), { token: null }));
results.push(await j(R1, "ss:bad-bearer", "POST", S(L2), goodSubmit(), { token: "garbage-token-xyz" }));

// recordId path variants
for (const [name, loop] of [
  ["ss:rid-missing", "nosuchloop"],
  ["ss:rid-129", "l".repeat(129)],
  ["ss:rid-10k", "l".repeat(10000)],
  ["ss:rid-nullbyte", "a%00b"],
  ["ss:rid-dotdot", ".."],
  ["ss:rid-unicode", encodeURIComponent("🪔")],
  ["ss:rid-traversal", "a%2f..%2fb"],
]) results.push(await j(R1, name, "POST", S(loop), goodSubmit()));
// roomId variants
for (const [name, path] of [
  ["ss:room-missing", "/api/rooms/nosuchroom/signoff-loops/fuzzloop1/submit"],
  ["ss:room-400", `/api/rooms/${"r".repeat(400)}/signoff-loops/fuzzloop1/submit`],
  ["ss:room-empty", "/api/rooms//signoff-loops/fuzzloop1/submit"],
  ["ss:room-nullbyte", "/api/rooms/a%00b/signoff-loops/fuzzloop1/submit"],
]) results.push(await j(R1, name, "POST", path, goodSubmit()));
// method matrix on the submit path
for (const m of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
  const headers = { "Content-Type": "application/json" };
  results.push(await fetchCase(R1, `ss:method-${m}`, m, S(L2), m === "TRACE" ? { headers } : { headers, body: '{"a":1}' }));
}
results.push(await fetchCase(R1, "ss:trailing-slash", "POST", S(L2) + "/", { headers: { "Content-Type": "application/json" }, body: "{}" }));
results.push(await fetchCase(R1, "ss:huge-query", "POST", S(L2) + "?q=" + "y".repeat(8192), { headers: { "Content-Type": "application/json" }, body: JSON.stringify(goodSubmit()) }));
// replay semantics
const replayId = "req44-replay";
results.push(await j(R1, "ss:replay-same", "POST", S(L2), goodSubmit({ requestId: replayId })));
results.push(await j(R1, "ss:replay-same-again", "POST", S(L2), goodSubmit({ requestId: replayId })));
results.push(await j(R1, "ss:replay-diff", "POST", S(L2), goodSubmit({ requestId: replayId, summary: "different" })));
// status transition: valid submit turns loop submitted; second submit should 422
const st = goodSubmit();
results.push(await j(R1, "ss:transition-first", "POST", S(L2), st));
results.push(await j(R1, "ss:transition-second", "POST", S(L2), goodSubmit()));
// candidate path: candidate submits as the bound candidate (fuzzloop1 trial-1)
const candSubmit = goodSubmit({ candidateId: "cand44" });
results.push(await j(R1, "ss:candidate-as-owner", "POST", S(L1), candSubmit));
results.push(await j(R1, "ss:candidate-own", "POST", S(L1), candSubmit, { token: candidate.key }));
// rate burst
for (let i = 0; i < 70; i++) results.push(await j(R1, `ss:burst-${i}`, "POST", S(L2), goodSubmit()));

console.log("signoff batch done, health:", await healthOk());

// ============ raw socket abuse on both paths ============
const rawTargets = [S(L2), W()];
for (const p of rawTargets) {
  for (const [name, payload] of [
    ["raw:bad-request-line", "HELLO WORLD\r\n\r\n"],
    ["raw:truncated", `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"a":1}`],
    ["raw:cl-lie-big", `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n{"a":1}`],
    ["raw:cl-lie-small", `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{"a":12345}`],
    ["raw:double-cl", `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 0\r\n\r\n`],
    ["raw:chunked-invalid", `POST ${p} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\nhello\r\n0\r\n\r\n`],
    ["raw:null-in-path", `POST ${p}\x00 HTTP/1.1\r\nHost: x\r\n\r\n`],
  ]) {
    const r = await rawRequest(payload, 6000);
    results.push({ route: "raw", name: `${name} :: ${p}`, method: "RAW", path: p.slice(0, 80), status: r.status, ms: null, head: r.head });
  }
}
console.log("raw batch done, health:", await healthOk());

// ============ flag findings ============
const findings = [];
for (const r of results) {
  const benign429 = r.status === 429;
  const rawBenign = r.route === "raw" && ["TIMEOUT", "CLOSED", "SOCKET-ERROR"].includes(r.status);
  const clientNoise = r.status === "FETCH-ERROR" && /Failed to parse URL|Invalid/.test(r.head || "");
  if (rawBenign || clientNoise || benign429) continue;
  if (r.status === 500 || r.status === "TIMEOUT" || r.status === "FETCH-ERROR" || r.status === "SOCKET-ERROR" || looksLikeStack(r.head)) {
    findings.push({ ...r, verdict: r.status === 500 ? "unexpected-500" : r.status === "TIMEOUT" ? "hang" : "transport-anomaly", stackLeak: looksLikeStack(r.head) });
  }
}

const fs = await import("node:fs");
fs.writeFileSync("/home/hatch/workspace/pr-wave2000-guild-02/worker-44/results.json", JSON.stringify({ total: results.length, findings: findings.length, findings, results }, null, 1));
console.log(`done: ${results.length} cases, ${findings.length} findings, final health: ${await healthOk()}`);

server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close();
