// Property/fuzz tests for the main REST write endpoints. Invariant: arbitrary
// JSON (or non-JSON) bodies never produce a 5xx, a non-JSON error, or a
// stored claim the list cannot read back. Only real bugs fail: 4xx refusals
// are expected and never asserted on. Seeded so failures reproduce.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import fc from "fast-check";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261103);
const RUNS = Number(process.env.FUZZ_RUNS ?? 60);

async function boot(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.store.close(); try { rmSync(f.directory, { recursive: true, force: true }); } catch {} });
  const o = `http://127.0.0.1:${server.address().port}/api/rooms/commons`;
  const H = { "Content-Type": "application/json", Authorization: "Bearer " + f.keys.owner };
  return { o, H };
}

const fieldNames = fc.constantFrom("id", "title", "note", "tags", "files", "dependsOn", "parentClaimId", "evidenceRefs",
  "pullRequest", "repo", "branch", "kind", "revision", "assignee", "reviewPolicy", "acceptanceCriteria", "state",
  "type", "data", "text", "body", "__proto__", "constructor", "expectedRevision", "workItemId", "x");
const anyBody = fc.oneof(
  fc.dictionary(fieldNames, fc.jsonValue({ maxDepth: 3 }), { maxKeys: 8 }),
  fc.jsonValue({ maxDepth: 3 }),
);

async function send(url, method, H, body, raw = false) {
  const r = await fetch(url, { method, headers: H, body: raw ? body : JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.status < 500, `${method} ${url} -> ${r.status} ${text.slice(0, 200)}`);
  if (r.status >= 400) assert.doesNotThrow(() => JSON.parse(text), `non-JSON ${r.status} error body`);
  return { status: r.status, text };
}

test("POST work-claims: arbitrary bodies never 5xx", async (t) => {
  const { o, H } = await boot(t);
  await fc.assert(fc.asyncProperty(anyBody, async (b) => { await send(o + "/work-claims", "POST", H, b); }), { seed: SEED, numRuns: RUNS });
});

test("POST work-claims: malformed raw bodies never 5xx", async (t) => {
  const { o, H } = await boot(t);
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 300 }), async (s) => { await send(o + "/work-claims", "POST", H, s, true); }), { seed: SEED, numRuns: RUNS });
});

test("POST work-claims: valid ids and titles round-trip through the list", async (t) => {
  const { o, H } = await boot(t);
  const id = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,40}$/);
  const title = fc.string({ minLength: 1, maxLength: 120 }).filter((s) => s.trim().length > 0);
  const seen = new Set();
  await fc.assert(fc.asyncProperty(id, title, async (i, ti) => {
    if (seen.has(i)) return; seen.add(i);
    const { status } = await send(o + "/work-claims", "POST", H, { id: i, title: ti });
    if (status !== 201) return; // server may normalise or refuse odd titles; never 5xx
    const r = await fetch(o + "/work-claims?limit=200", { headers: H });
    assert.equal(r.status, 200);
    const claims = (await r.json()).claims;
    assert.ok(claims.some((c) => c.id === i), `created ${i} missing from list`);
  }), { seed: SEED, numRuns: Math.min(RUNS, 40) });
});

test("PATCH/POST on a claim: arbitrary bodies never 5xx", async (t) => {
  const { o, H } = await boot(t);
  await send(o + "/work-claims", "POST", H, { id: "fuzz-target", title: "Fuzz target" });
  await fc.assert(fc.asyncProperty(fc.constantFrom("", "/claim", "/release", "/close", "/cancel"), anyBody, async (sub, b) => {
    await send(o + "/work-claims/fuzz-target" + sub, "POST", H, b);
  }), { seed: SEED, numRuns: RUNS });
});

test("POST commands: arbitrary bodies never 5xx", async (t) => {
  const { o, H } = await boot(t);
  await fc.assert(fc.asyncProperty(fc.constant("/commands"), anyBody, async (p, b) => {
    await send(o + p, "POST", H, b);
  }), { seed: SEED, numRuns: RUNS });
});
