// FIX-55: capacity digest — fail-first acceptance tests.
// Pure computation tests (offline fixtures) + transport opt-in tests.
// Run: node --test tests/capacity-digest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_CAP_DEFAULT,
  OPEN_CLAIM_STATES,
  countOpenClaims,
  normalizeBoard,
  normalizeCiQueue,
  buildDigest,
  postDigest,
} from "../scripts/capacity-digest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "capacity-digest.mjs");

const NOW = "2026-10-09T13:50:00.000Z";

// --- fixtures -------------------------------------------------------------

const fullBoard = () =>
  normalizeBoard({ claims: Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, state: "claimed" })) });

const mixedBoard = () =>
  normalizeBoard({
    claims: [
      { id: "a", state: "claimed" },
      { id: "b", state: "in_progress" },
      { id: "c", state: "blocked" },
      { id: "d", state: "unclaimed" },
      { id: "e", state: "done" }, // terminal: not open
      { id: "f", state: "closed" }, // terminal: not open
    ],
  });

const kneeSample = () => ({
  type: "ci.queue_depth_sample",
  id: "ciqd-20261009T133500Z-ab12",
  timestamp: "2026-10-09T13:35:00.000Z",
  repo: "Uuriko/project-room",
  interval_s: 900,
  queued: 443,
  running: 8,
  p50_wait_s: 8100,
  max_wait_s: 12000,
  knee: { alert: true, rho_hat: 1.34, reason: "trend +0.92 queued/min, R² 0.93 over 8 samples" },
});

const calmSample = () => ({
  type: "ci.queue_depth_sample",
  id: "ciqd-20261009T133500Z-cd34",
  timestamp: "2026-10-09T13:35:00.000Z",
  repo: "Uuriko/project-room",
  interval_s: 900,
  queued: 12,
  running: 8,
  p50_wait_s: 390,
  max_wait_s: 1500,
  knee: { alert: false, rho_hat: 0.62, reason: "stable window" },
});

// --- board normalization ---------------------------------------------------

test("board cap defaults to the room's 200 open-claim cap", () => {
  assert.equal(BOARD_CAP_DEFAULT, 200);
  assert.deepEqual([...OPEN_CLAIM_STATES].sort(), ["blocked", "claimed", "in_progress", "unclaimed"]);
});

test("countOpenClaims counts only non-terminal states", () => {
  assert.equal(countOpenClaims(mixedBoard().claims), 4);
});

test("normalizeBoard accepts a raw open count too", () => {
  const b = normalizeBoard({ open: 42 });
  assert.equal(b.open, 42);
  assert.equal(b.cap, 200);
  const custom = normalizeBoard({ open: 42, cap: 50 });
  assert.equal(custom.cap, 50);
});

// --- FIX-55 acceptance: board FULL -----------------------------------------

test("board at 200/200 → digest shows FULL + backpressure note", () => {
  const d = buildDigest({ board: fullBoard(), ciQueue: normalizeCiQueue(calmSample()), now: NOW });
  assert.ok(d.text.includes("200/200"), `digest text must show 200/200, got:\n${d.text}`);
  assert.ok(d.text.includes("FULL"), `digest text must flag FULL, got:\n${d.text}`);
  assert.ok(/backpressure/i.test(d.text), `digest must carry a backpressure note, got:\n${d.text}`);
  const kinds = d.alerts.map((a) => a.kind);
  assert.ok(kinds.includes("board_full"), `alerts must include board_full, got ${JSON.stringify(kinds)}`);
  assert.equal(d.alerts.find((a) => a.kind === "board_full").level, "critical");
  assert.equal(d.gauges.board.open, 200);
  assert.equal(d.gauges.board.cap, 200);
  assert.equal(d.gauges.board.full, true);
});

test("board at 87% warns but is not FULL", () => {
  const d = buildDigest({ board: normalizeBoard({ open: 175 }), ciQueue: null, now: NOW });
  const kinds = d.alerts.map((a) => a.kind);
  assert.ok(kinds.includes("board_high"));
  assert.ok(!kinds.includes("board_full"));
  assert.equal(d.gauges.board.full, false);
  assert.ok(!d.text.includes("FULL"));
});

// --- FIX-55 acceptance: CI knee --------------------------------------------

test("CI ρ>1 → knee alert present in digest", () => {
  const d = buildDigest({ board: normalizeBoard({ open: 142 }), ciQueue: normalizeCiQueue(kneeSample()), now: NOW });
  const kinds = d.alerts.map((a) => a.kind);
  assert.ok(kinds.includes("ci_knee"), `alerts must include ci_knee, got ${JSON.stringify(kinds)}`);
  assert.ok(/knee/i.test(d.text), `digest text must mention the knee, got:\n${d.text}`);
  assert.ok(d.text.includes("443"), "digest must show the queued depth gauge");
  assert.ok(d.text.includes("135m"), "digest must show p50 wait 8100s as 135m");
  assert.equal(d.gauges.ci.kneeAlert, true);
  assert.equal(d.gauges.ci.rhoHat, 1.34);
});

// --- FIX-55 acceptance: calm -------------------------------------------------

test("calm state → gauges present, no alerts", () => {
  const d = buildDigest({ board: normalizeBoard({ open: 142 }), ciQueue: normalizeCiQueue(calmSample()), now: NOW });
  assert.deepEqual(d.alerts, []);
  assert.ok(/no alerts/i.test(d.text), `calm digest must say no alerts, got:\n${d.text}`);
  assert.ok(d.text.includes("142/200"), "digest must show the board gauge");
  assert.ok(d.text.includes("12 queued"), "digest must show the CI queued gauge");
  assert.equal(d.gauges.board.pct, 0.71);
});

test("missing CI data → digest says so, no knee alert invented", () => {
  const d = buildDigest({ board: normalizeBoard({ open: 10 }), ciQueue: normalizeCiQueue(null), now: NOW });
  assert.deepEqual(d.alerts, []);
  assert.ok(/no ci data/i.test(d.text), `digest must note missing CI data, got:\n${d.text}`);
  assert.equal(d.gauges.ci, null);
});

test("knee record without a verdict → gauges only, no alert", () => {
  const sample = calmSample();
  delete sample.knee;
  const d = buildDigest({ board: normalizeBoard({ open: 10 }), ciQueue: normalizeCiQueue(sample), now: NOW });
  assert.ok(!d.alerts.some((a) => a.kind === "ci_knee"));
  assert.equal(d.gauges.ci.kneeAlert, null);
});

// --- transport: opt-in only ---------------------------------------------------

test("postDigest POSTs the digest payload as JSON (injectable fetch)", async () => {
  const d = buildDigest({ board: normalizeBoard({ open: 5 }), ciQueue: null, now: NOW });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  const res = await postDigest(d, { url: "https://example.test/hook", token: "sekret", fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/hook");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["content-type"], "application/json");
  assert.equal(calls[0].opts.headers.authorization, "Bearer sekret");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.text, d.text);
  assert.deepEqual(body.alerts, d.alerts);
});

test("postDigest throws without a URL — never a silent misfire", async () => {
  const d = buildDigest({ board: normalizeBoard({ open: 5 }), ciQueue: null, now: NOW });
  await assert.rejects(() => postDigest(d, { url: "", fetchImpl: async () => ({ ok: true, status: 200 }) }), /url/i);
});

// --- CLI: offline smoke -------------------------------------------------------

const runCli = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, timeout: 15000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });

const writeTmp = (name, obj) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-digest-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
  return file;
};

test("CLI default prints the digest to stdout and never posts", async () => {
  const boardFile = writeTmp("board.json", { open: 200 });
  const ciFile = writeTmp("ci.json", kneeSample());
  const { code, stdout, stderr } = await runCli(["--board-fixture", boardFile, "--ci-fixture", ciFile, "--now", NOW]);
  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("200/200"), `stdout:\n${stdout}`);
  assert.ok(/knee/i.test(stdout), `stdout:\n${stdout}`);
});

test("CLI --post without a webhook URL fails loudly instead of posting nowhere", async () => {
  const boardFile = writeTmp("board.json", { open: 3 });
  const { code, stderr } = await runCli(["--board-fixture", boardFile, "--post"], { CAPACITY_DIGEST_WEBHOOK_URL: "" });
  assert.notEqual(code, 0);
  assert.ok(/webhook/i.test(stderr), `stderr:\n${stderr}`);
});

test("CLI --ci-log reads the latest JSONL line", async () => {
  const boardFile = writeTmp("board.json", { open: 10 });
  const logFile = writeTmp("samples.jsonl", `${JSON.stringify(calmSample())}\n${JSON.stringify(kneeSample())}\n`);
  const { code, stdout, stderr } = await runCli(["--board-fixture", boardFile, "--ci-log", logFile, "--now", NOW]);
  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("443"), `must use the latest (knee) sample, stdout:\n${stdout}`);
});
