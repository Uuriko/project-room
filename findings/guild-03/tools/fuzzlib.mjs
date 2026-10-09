// Guild-03 HTTP fuzz harness: boots a real server on a fixture store,
// fires hostile requests, asserts 4xx-never-500 + auth fail-closed + no hangs.
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const { RoomStore } = await import(`${REPO}/server/store.mjs`);
const { initialRoom } = await import(`${REPO}/server/bootstrap.mjs`);
const { createRoomServer } = await import(`${REPO}/server/http.mjs`);

export async function bootFuzzServer({ roomId = "fuzzroom" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "guild03-fuzz-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  const ownerToken = store.issueAccessKey(roomId, "owner");
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, store, ownerToken, roomId, directory,
    async close() {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(r => server.close(r)); store.close();
      rmSync(directory, { recursive: true, force: true });
    } };
}

// Shared hostile payload generators
export const evil = {
  big: (n = 200000) => "x".repeat(n),
  huge: () => "x".repeat(5 * 1024 * 1024),
  traversal: "../../etc/passwd",
  longId: "a".repeat(5000),
  unicode: "𝕳𝖊𝖑𝖑𝖔\0null\u202eRTL",
  types: [null, true, 42, 3.14, [], {}, ["a"], { nested: { deep: [1] } }],
  verbs: ["PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "HEAD"],
  auths: [
    ["no-auth", {}],
    ["garbage-bearer", { Authorization: "Bearer garbage-token-xyz" }],
    ["empty-bearer", { Authorization: "Bearer " }],
    ["wrong-scheme", { Authorization: "Basic abc123" }],
    ["null-byte", { Authorization: "Bearer ab\0cd" }],
  ],
};

export async function runCases(origin, cases, { timeoutMs = 8000 } = {}) {
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    let status = null, err = null, bodyText = "";
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(origin + c.path, {
        method: c.method || "GET",
        headers: { "Content-Type": "application/json", ...(c.headers || {}) },
        body: c.rawBody !== undefined ? c.rawBody
          : (c.body !== undefined ? (typeof c.body === "string" ? c.body : JSON.stringify(c.body)) : undefined),
        signal: ctl.signal, redirect: "manual",
      });
      clearTimeout(to);
      status = res.status;
      bodyText = (await res.text()).slice(0, 300);
    } catch (e) { err = `${e.name}: ${String(e.message).slice(0, 120)}`; }
    const ms = Date.now() - t0;
    results.push({ name: c.name, method: c.method || "GET", path: String(c.path).slice(0, 140),
      status, ms, hung: err?.startsWith("AbortError") ?? false, err, bodyText, bypass: !!c.bypass });
  }
  return results;
}

// Verdicts: 500 or hang = FAIL; auth-bypass cases must not return 2xx.
export function summarize(unitId, results, mdPath) {
  let fails = 0, hangs = 0, serverErr = 0, bypass2xx = [];
  const lines = [`\n## ${unitId} — ${results.length} hostile inputs`];
  for (const r of results) {
    const tag = r.hung ? "HANG" : r.status === 500 ? "500" : r.status === null ? "ERR" : String(r.status);
    if (r.hung) hangs++;
    if (r.status === 500) serverErr++;
    if (r.status === null && !r.hung) fails++;
    if (r.bypass && r.status >= 200 && r.status < 300) bypass2xx.push(r.name);
    lines.push(`- [${tag}] ${r.ms}ms ${r.method} ${r.path} — ${r.name}${r.err ? ` (${r.err})` : ""}`);
  }
  lines.push(`\nverdict: ${hangs} hangs, ${serverErr} HTTP-500s, ${fails} transport errors, ${bypass2xx.length} auth-bypass 2xx [${bypass2xx.join(", ")}]`);
  appendFileSync(mdPath, lines.join("\n") + "\n");
  return { hangs, serverErr, fails, bypass2xx };
}
