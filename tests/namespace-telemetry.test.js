// FIX-58: per-namespace telemetry — fail-first acceptance tests.
//
// Mission: "per-namespace telemetry under the claim-channel redesign
// (namespaces endpoint: live open + top-5 holders)". Namespaces are guild
// scopes in the CURRENT model = the top-level directory of a claim's file
// scopes (FIX-48's scope spine: `server/` and `server/http.mjs` both live in
// namespace `server`). This re-homes onto FIX-68's claim channels when the
// redesign lands — see docs/telemetry/namespace-telemetry.md.
//
// The "endpoint" is the pure builder buildNamespaceTelemetry (same surface
// shape as FIX-55's buildDigest in scripts/capacity-digest.mjs: computation
// separated from transport so tests run offline on fixtures).
//
// Run: node --test tests/namespace-telemetry.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPEN_CLAIM_STATES,
  namespacesOf,
  buildNamespaceTelemetry,
  postTelemetry,
} from "../scripts/namespace-telemetry.mjs";
import { validateRecord } from "../scripts/telemetry-schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "namespace-telemetry.mjs");

const NOW = "2026-10-09T21:05:00.000Z";

// --- fixtures --------------------------------------------------------------

// Claims open across several guild scopes (namespaces).
const boardClaims = () => [
  { id: "c1", owner: "quill", state: "claimed", files: ["server/http.mjs"] },
  { id: "c2", owner: "quill", state: "in_progress", files: ["server/"] },
  { id: "c3", owner: "instinct", state: "blocked", files: ["server/claim-coordination.mjs"] },
  { id: "c4", owner: null, state: "unclaimed", files: ["server/room.mjs"] },
  { id: "c5", owner: "fo", state: "claimed", files: ["client/room-agent.mjs", "client/room-coord.mjs"] },
  { id: "c6", owner: "fo", state: "in_progress", files: ["client/"] },
  { id: "c7", owner: "grok", state: "claimed", files: ["docs/telemetry/schema.md"] },
  { id: "c8", owner: "quill", state: "done", files: ["server/http.mjs"] }, // terminal: not live
  { id: "c9", owner: "quill", state: "closed", files: ["client/room-agent.mjs"] }, // terminal: not live
  { id: "c10", owner: "tab", state: "claimed", files: [] }, // no scopes -> unscoped
  { id: "c11", owner: "dot", state: "claimed" }, // no files key at all -> unscoped
];

const byNamespace = (records) => Object.fromEntries(records.map((r) => [r.namespace, r]));

// --- namespace derivation ---------------------------------------------------

test("namespacesOf maps file scopes to their top-level directory (guild scope)", () => {
  assert.deepEqual(namespacesOf({ files: ["server/http.mjs"] }), ["server"]);
  assert.deepEqual(namespacesOf({ files: ["server/"] }), ["server"]);
  assert.deepEqual(namespacesOf({ files: ["server/", "client/room-agent.mjs"] }), ["client", "server"]);
});

test("namespacesOf puts scopeless claims in the unscoped bucket", () => {
  assert.deepEqual(namespacesOf({ files: [] }), ["unscoped"]);
  assert.deepEqual(namespacesOf({}), ["unscoped"]);
  assert.deepEqual(namespacesOf({ files: [null, 42] }), ["unscoped"]);
});

test("OPEN_CLAIM_STATES matches the capacity-digest open set", () => {
  assert.deepEqual([...OPEN_CLAIM_STATES].sort(), ["blocked", "claimed", "in_progress", "unclaimed"]);
});

// --- the namespaces endpoint -------------------------------------------------

test("endpoint returns per-namespace live-open counts", () => {
  const { records } = buildNamespaceTelemetry({ claims: boardClaims(), now: NOW });
  const ns = byNamespace(records);
  assert.deepEqual(Object.keys(ns).sort(), ["client", "docs", "server", "unscoped"]);
  // server: c1, c2, c3, c4 open (c8 done is terminal, excluded)
  assert.equal(ns.server.queued, 4);
  // client: c5, c6 open (c9 closed is terminal, excluded)
  assert.equal(ns.client.queued, 2);
  assert.equal(ns.docs.queued, 1);
  assert.equal(ns.unscoped.queued, 2);
});

test("endpoint returns top-5 holders per namespace, ranked by open claims", () => {
  const claims = [];
  const holders = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"];
  holders.forEach((h, i) => {
    for (let k = 0; k < holders.length - i; k++) {
      claims.push({ id: `${h}-${k}`, owner: h, state: "claimed", files: ["server/x.mjs"] });
    }
  });
  const { records } = buildNamespaceTelemetry({ claims, now: NOW });
  assert.equal(records.length, 1);
  const top = records[0].top_holders;
  assert.equal(top.length, 5);
  assert.deepEqual(top.map((t) => t.holder), ["h1", "h2", "h3", "h4", "h5"]);
  assert.deepEqual(top.map((t) => t.open), [7, 6, 5, 4, 3]);
});

test("holder ranking breaks ties deterministically by holder name", () => {
  const claims = [
    { id: "a", owner: "zed", state: "claimed", files: ["server/a.mjs"] },
    { id: "b", owner: "amy", state: "claimed", files: ["server/b.mjs"] },
  ];
  const { records } = buildNamespaceTelemetry({ claims, now: NOW });
  assert.deepEqual(records[0].top_holders.map((t) => t.holder), ["amy", "zed"]);
});

test("unclaimed (ownerless) claims count as open but not as holders", () => {
  const { records } = buildNamespaceTelemetry({ claims: boardClaims(), now: NOW });
  const server = byNamespace(records).server;
  // c4 is unclaimed: open in the count, absent from holders
  assert.equal(server.queued, 4);
  assert.equal(server.running, 2); // quill + instinct; the unclaimed claim has no holder
  assert.deepEqual(server.top_holders.map((t) => t.holder).sort(), ["instinct", "quill"]);
  const quill = server.top_holders.find((t) => t.holder === "quill");
  assert.equal(quill.open, 2);
});

test("cap comes from the caps map; null when the current model has no per-namespace cap", () => {
  const { records } = buildNamespaceTelemetry({
    claims: boardClaims(),
    caps: { server: 30 },
    now: NOW,
  });
  const ns = byNamespace(records);
  assert.equal(ns.server.cap, 30);
  assert.equal(ns.client.cap, null);
  assert.equal(ns.unscoped.cap, null);
});

// --- v:1 schema conformance ----------------------------------------------------

test("every record validates against the v:1 telemetry schema (kind gauge)", () => {
  const { records } = buildNamespaceTelemetry({ claims: boardClaims(), now: NOW });
  assert.ok(records.length > 0);
  for (const r of records) {
    assert.equal(r.v, 1);
    assert.equal(r.kind, "gauge");
    assert.equal(r.type, "namespace.open_claims");
    const { ok, errors } = validateRecord(r);
    assert.ok(ok, `record for ${r.namespace} failed validation: ${errors.join("; ")}`);
  }
});

test("gauge field mapping is documented and stable", () => {
  const { records } = buildNamespaceTelemetry({ claims: boardClaims(), now: NOW });
  const server = byNamespace(records).server;
  assert.equal(server.repo, "Uuriko/project-room");
  assert.equal(server.interval_s, 0); // point-in-time snapshot, not a windowed rate
  assert.equal(server.queued, server.top_holders.reduce((n, t) => n + t.open, 0) + 1); // +1 unclaimed
  assert.equal(server.p50_wait_s, null); // no queue-wait semantics on a namespace point sample
  assert.equal(typeof server.ts, "string");
  assert.equal(server.timestamp, server.ts); // legacy alias, like FIX-22c
});

test("empty board yields no records (never an invented namespace)", () => {
  const { records } = buildNamespaceTelemetry({ claims: [], now: NOW });
  assert.deepEqual(records, []);
});

test("board input accepts a bare claims array or { claims }", () => {
  const a = buildNamespaceTelemetry({ claims: boardClaims(), now: NOW });
  const b = buildNamespaceTelemetry({ board: { claims: boardClaims() }, now: NOW });
  assert.deepEqual(a.records, b.records);
});

// --- transport is opt-in ---------------------------------------------------------

test("postTelemetry refuses to post without a url", async () => {
  await assert.rejects(postTelemetry([], {}), /needs a webhook url/);
});

test("postTelemetry posts JSONL to the url with injectable fetch", async () => {
  const seen = {};
  const fakeFetch = async (url, opts) => {
    seen.url = url;
    seen.body = opts.body;
    seen.contentType = opts.headers["content-type"];
    return { ok: true, status: 200 };
  };
  const { records } = buildNamespaceTelemetry({ claims: boardClaims(), now: NOW });
  const res = await postTelemetry(records, { url: "https://example.test/hook", fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.equal(seen.url, "https://example.test/hook");
  assert.equal(seen.contentType, "application/json");
  const lines = seen.body.trim().split("\n");
  assert.equal(lines.length, records.length);
  for (const line of lines) {
    const { ok } = validateRecord(JSON.parse(line));
    assert.ok(ok);
  }
});

// --- CLI smoke ---------------------------------------------------------------------

test("CLI prints v:1 JSONL records to stdout from a board fixture", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-tel-"));
  const fixture = path.join(dir, "board.json");
  fs.writeFileSync(fixture, JSON.stringify({ claims: boardClaims() }));
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [script, ...args], { encoding: "utf8" }, (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout, stderr })
      );
    });
  const { stdout } = await run(["--board-fixture", fixture, "--now", NOW]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    const { ok, errors } = validateRecord(JSON.parse(line));
    assert.ok(ok, `CLI line failed validation: ${errors.join("; ")}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI --post without NAMESPACE_TELEMETRY_WEBHOOK_URL fails loudly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-tel-"));
  const fixture = path.join(dir, "board.json");
  fs.writeFileSync(fixture, JSON.stringify({ claims: boardClaims() }));
  const code = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, "--board-fixture", fixture, "--post"],
      { encoding: "utf8", env: { ...process.env, NAMESPACE_TELEMETRY_WEBHOOK_URL: "" } },
      (err) => resolve(err ? err.code : 0)
    );
  });
  assert.notEqual(code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
