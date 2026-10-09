// Fuzz driver B2-B5 — state/network/eligibility targets. wave1000 guild-07.
// (B1 corrupt-state cases already ran; logged in fuzz.md.)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = "/home/hatch/workspace/pr-wave1000-guild-07";
const logPath = join(W, "findings/guild-07/fuzz.md");
const jsonPath = join(HERE, "work/fuzz-b2.json");
const log = t => writeFileSync(logPath, t, { flag: "a" });
const results = [];
const XSS = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

async function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`HANG: ${label} exceeded ${ms}ms`)), ms); });
  try { return await Promise.race([promise, t]); }
  finally { clearTimeout(timer); }
}
function rec(id, input, outcome, note = "") {
  results.push({ id, input, outcome, note });
  log(`- **${id}** \`${input}\` → ${outcome}${note ? ` — ${note}` : ""}\n`);
}

const { validateRequestNotice } = await import(`${W}/client/request-notices.mjs`);
const { PublicWorkClaimsClient } = await import(`${W}/client/public-work-claims.mjs`);
const { isRequestEligible } = await import(`${W}/client/request-runner.mjs`);
const { validReplyArguments, replyTools, buildReplyCommand } = await import(`${W}/client/reply-actions.mjs`);

log(`\n# Fuzz driver B2-B5 — state/network (run ${new Date().toISOString()})\n`);

// ---- B2: validateRequestNotice hostile notices ----
log(`\n## B2 validateRequestNotice hostile inputs\n`);
const binding = { memberId: "m1" };
const b2 = [
  ["null", null, ["sig"], "k"],
  ["xss-fields", { subject: "request", id: XSS, roomId: XSS }, ["sig"], "k"],
  ["wrong-types", { subject: 42, id: [], charter: "x" }, "not-array", "k"],
  ["deep", (() => { let o = { subject: "request" }; let c = o; for (let i = 0; i < 2000; i++) { c.n = {}; c = c.n; } return o; })(), [], "k"],
  ["proto", JSON.parse('{"subject":"request","__proto__":{"p":1}}'), [], "k"],
];
for (const [name, notice, sig, key] of b2) {
  try {
    await withTimeout(Promise.resolve(validateRequestNotice(notice, sig, key, binding)), 8000, `B2/${name}`);
    rec("B2", name, "ACCEPTED", "unexpected — hostile notice passed validation?");
  } catch (e) {
    rec("B2", name, e.message.startsWith("HANG") ? "HANG" : "OK-REJECT", e.constructor.name + ": " + String(e.message).slice(0, 80));
  }
}

// ---- B3: client request timeout / flapping fetch ----
log(`\n## B3 PublicWorkClaimsClient timeout + flapping fetch\n`);
function fakeReader(chunks) {
  const q = [...chunks];
  return { read: async () => q.length ? { done: false, value: q.shift() } : { done: true, value: undefined }, cancel: async () => {}, releaseLock() {} };
}
const okResp = () => ({ ok: true, status: 200, body: { getReader: () => fakeReader([Buffer.from(JSON.stringify({ recommendations: [], inspected: 0, hasMore: false, nextCursor: null, supportedRewards: ["volunteer"], claim: null }))]) } });
{
  const c = new PublicWorkClaimsClient({ origin: "https://room.example.com", timeoutMs: 1000, fetchImpl: () => new Promise(() => {}) });
  const t0 = Date.now();
  try { await withTimeout(c.match({}), 8000, "B3/never-resolves"); rec("B3", "never-resolves", "RETURNED", "unexpected"); }
  catch (e) {
    const dt = Date.now() - t0;
    rec("B3", "never-resolves", e.message.startsWith("HANG") ? "HANG-BUG" : "OK-REJECT", `settled in ${dt}ms code=${e.code ?? "?"}`);
  }
}
{
  let n = 0;
  const c = new PublicWorkClaimsClient({ origin: "https://room.example.com", timeoutMs: 3000,
    fetchImpl: async () => { if (++n < 3) throw new Error("flap"); return okResp(); } });
  try { await withTimeout(c.match({}), 8000, "B3/flap"); rec("B3", "flap-then-ok", "THREW-FIRST", "no retry inside single request — caller retries; ok"); }
  catch (e) { rec("B3", "flap-then-ok", "OK-REJECT", `code=${e.code ?? e.constructor.name}`); }
}

// ---- B4: isRequestEligible hostile requests ----
log(`\n## B4 isRequestEligible hostile inputs\n`);
const b4 = [
  ["null", null, {}], ["undef", undefined, {}], ["status-num", { status: 5 }, {}],
  ["status-xss", { status: XSS }, {}], ["getter-throws", Object.defineProperty({}, "status", { get() { throw new Error("getter"); } }), {}],
  ["proxy", new Proxy({ status: "open" }, { get(t, k) { if (k === "status") return "open"; return t[k]; } }), { owned: true, runState: "x", hasPendingDelivery: false }],
  ["open-owned", { status: "open" }, { owned: true, runState: "needs_attention", hasPendingDelivery: true }],
  ["open-unowned", { status: "open" }, { owned: false }],
];
for (const [name, req, opts] of b4) {
  try {
    const v = await withTimeout(Promise.resolve(isRequestEligible(req, opts)), 5000, `B4/${name}`);
    rec("B4", name, typeof v === "boolean" ? `OK-boolean(${v})` : "BAD-TYPE", "");
  } catch (e) { rec("B4", name, e.message.startsWith("HANG") ? "HANG" : "THREW", e.constructor.name + ": " + String(e.message).slice(0, 80)); }
}

// ---- B5: reply validators hostile args ----
log(`\n## B5 validReplyArguments / buildReplyCommand hostile args\n`);
const toolName = replyTools[0]?.name ?? "room_unknown";
const deep = (() => { let o = {}; let c = o; for (let i = 0; i < 8000; i++) { c.n = {}; c = c.n; } return o; })();
const circular = { a: 1 }; circular.self = circular;
const b5 = [
  ["xss", { body: XSS }], ["deep", { body: "x", deep }], ["circular", circular],
  ["big", { body: "y".repeat(5 * 1024 * 1024) }], ["proto", JSON.parse('{"body":"x","__proto__":{"p":1}}')],
  ["null", null], ["array", [1, 2, 3]],
];
for (const [name, args] of b5) {
  try {
    const v = await withTimeout(Promise.resolve(validReplyArguments(toolName, args)), 8000, `B5/${name}`);
    rec("B5", name, typeof v === "boolean" ? `OK-boolean(${v})` : "BAD-TYPE", "");
  } catch (e) { rec("B5", name, e.message.startsWith("HANG") ? "HANG" : "THREW", e.constructor.name + ": " + String(e.message).slice(0, 80)); }
}
try {
  buildReplyCommand({ roomId: "r1", memberId: "m1" }, toolName, { body: "x".repeat(100) });
  rec("B5", "build-valid", "OK", "");
} catch (e) { rec("B5", "build-valid", "THREW", String(e.message).slice(0, 80)); }
rec("B5", "proto-pollution-check", Object.prototype.p === undefined ? "OK-clean" : "BUG-POLLUTED", "");

writeFileSync(jsonPath, JSON.stringify({ results }, null, 2));
log(`\nFuzz driver B2-B5 done: ${results.length} cases.\n`);
console.log(`fuzz-b2 done: ${results.length} cases`);
