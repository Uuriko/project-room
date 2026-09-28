// RC-2026-09-24-204: synchronous pre-post validation of ```room-claim
// blocks for the #266 coordination board (POST /api/claims/validate).
//
// Three layers: the pure module (server/claim-validate.mjs), a differential
// parity check against scripts/room's own validate_claim jq def, and the
// HTTP wiring (open route, 30/address/min, 422 beyond 64KB).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  validateClaimText, validateClaimFields, parseClaimFields, extractClaimBlock,
  CLAIM_TEXT_MAX_LENGTH,
} from "../server/claim-validate.mjs";

const checkout = fileURLToPath(new URL("..", import.meta.url));

const block = lines => "```room-claim\n" + lines.join("\n") + "\n```";
const VALID = block([
  "task-id: RC-2026-09-24-204",
  "lane: jill",
  "files: server/claim-validate.mjs",
  "lease: lease=6h",
  "state: working",
  "reason: build the validator",
]);
const comment = inner => `[jill][claim] validating claims\n\n${inner}\n\nsome trailing prose`;

test("valid block -> valid:true with taskId and parsed fields", () => {
  const result = validateClaimText(comment(VALID));
  assert.equal(result.valid, true);
  assert.equal(result.taskId, "RC-2026-09-24-204");
  assert.deepEqual(result.fields, {
    "task-id": "RC-2026-09-24-204",
    lane: "jill",
    files: "server/claim-validate.mjs",
    lease: "lease=6h",
    state: "working",
    reason: "build the validator",
  });
  assert.ok(!("errors" in result));
});

test("no fenced block -> the exact rebuild error", () => {
  const result = validateClaimText("[jill][claim] prose without a fenced block");
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["no room-claim fenced block found"]);
  assert.deepEqual(result.fields, {});
  assert.equal(result.taskId, null);
});

test("each missing field reports its exact rebuild error", () => {
  const cases = [
    [["lane: jill", "files: a.mjs", "lease: lease=6h", "state: working", "reason: r"], "missing task-id"],
    [["task-id: RC-2026-09-24-204", "files: a.mjs", "lease: lease=6h", "state: working", "reason: r"], "missing lane"],
    [["task-id: RC-2026-09-24-204", "lane: jill", "lease: lease=6h", "state: working", "reason: r"], "missing files"],
    [["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "state: working", "reason: r"], "missing lease"],
    [["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=6h", "reason: r"], "missing state"],
    [["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=6h", "state: working"], "missing reason"],
  ];
  for (const [lines, error] of cases) {
    const result = validateClaimText(block(lines));
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, [error], lines.join(" / "));
  }
});

test("malformed values report their exact rebuild errors", () => {
  const base = {
    "task-id": "RC-2026-09-24-204", lane: "jill", files: "a.mjs",
    lease: "lease=6h", state: "working", reason: "r",
  };
  const mutate = (key, value) => block(Object.entries({ ...base, [key]: value }).map(([k, v]) => `${k}: ${v}`));
  const cases = [
    ["task-id", "RC-2026-9-24-204", "task-id not RC-YYYY-MM-DD-NNN"],
    ["task-id", "A010-2", "task-id not RC-YYYY-MM-DD-NNN"],
    ["task-id", "rc-2026-09-24-204", "task-id not RC-YYYY-MM-DD-NNN"],
    ["files", "server/*.mjs", "files: * forbidden"],
    ["lease", "6h", "lease must be lease=<N>h (1-72h); did you mean lease=6h?"], // the classic bare-6h mistake
    ["lease", "lease=6", "lease must be lease=<N>h"],
    ["lease", "lease=six-h", "lease must be lease=<N>h"],
    ["lease", "lease=0h", "lease out of range 1-72h"],
    ["lease", "lease=73h", "lease out of range 1-72h"],
    ["state", "failed", "failed requires a failure code"],
    ["state", "done", "unknown state word: done"],
    ["state", "failed()", "unknown state word: failed()"],
    ["state", "failed(BAD-CODE)", "unknown state word: failed(BAD-CODE)"],
  ];
  for (const [key, value, error] of cases) {
    const result = validateClaimText(mutate(key, value));
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, [error], `${key}=${value}`);
  }
});

test("accepted value shapes stay valid", () => {
  const base = {
    "task-id": "RC-2026-09-24-204", lane: "jill", files: "a.mjs",
    lease: "lease=6h", state: "working", reason: "r",
  };
  const mutate = fields => block(Object.entries({ ...base, ...fields }).map(([k, v]) => `${k}: ${v}`));
  for (const lease of ["lease=1h", "lease=72h", "lease=007h"]) {
    assert.equal(validateClaimText(mutate({ lease })).valid, true, lease);
  }
  for (const state of ["submitted", "working", "cancelled", "suspended", "completed", "failed(compile_error)"]) {
    assert.equal(validateClaimText(mutate({ state })).valid, true, state);
  }
  assert.equal(validateClaimText(mutate({ "task-id": "RC-2026-09-24-99999" })).valid, true);
});

test("violations accumulate in field order", () => {
  const result = validateClaimText(block(["task-id: nope", "files: x/*", "lease: never", "state: ???"]));
  assert.deepEqual(result.errors, [
    "task-id not RC-YYYY-MM-DD-NNN",
    "missing lane",
    "files: * forbidden",
    "lease must be lease=<N>h",
    "unknown state word: ???",
    "missing reason",
  ]);
});

test("duplicate keys: last wins, first-insertion order kept", () => {
  const fields = parseClaimFields([
    "task-id: RC-2026-09-24-204", "lane: jill", "lane: jill2",
    "files: a.mjs", "lease: lease=6h", "state: working", "reason: r",
  ].join("\n"));
  assert.equal(fields.lane, "jill2");
  assert.deepEqual(Object.keys(fields), ["task-id", "lane", "files", "lease", "state", "reason"]);
  assert.equal(validateClaimText(block([
    "task-id: RC-2026-09-24-204", "lane: jill", "lane: jill2",
    "files: a.mjs", "lease: lease=6h", "state: working", "reason: r",
  ])).valid, true);
});

test("field parsing details mirror the jq", () => {
  // Whitespace around keys/values, colons inside values, non-field lines.
  const fields = parseClaimFields([
    "  task-id  :   RC-2026-09-24-204  ",
    "\tlane:\tjill\t",
    "files: a:b.mjs",
    "- not a field line",
    "no colon here",
    "reason: build it",
  ].join("\n"));
  assert.deepEqual(fields, {
    "task-id": "RC-2026-09-24-204",
    lane: "jill",
    files: "a:b.mjs",
    reason: "build it",
  });
  // Keys are limited to [A-Za-z0-9_-].
  assert.deepEqual(parseClaimFields("weird key: x"), {});
  // Values that are only whitespace count as missing.
  const result = validateClaimText(block([
    "task-id: RC-2026-09-24-204", "lane:   ", "files: a.mjs",
    "lease: lease=6h", "state: working", "reason: r",
  ]));
  assert.deepEqual(result.errors, ["missing lane"]);
});

test("fence extraction details mirror the jq", () => {
  assert.equal(extractClaimBlock("no fence"), null);
  assert.equal(extractClaimBlock("```room-claim extra text\ntask-id: x\n```"), null);
  // Trailing spaces/tabs after the opening fence are allowed.
  assert.equal(extractClaimBlock("```room-claim  \nhello\n```"), "hello");
  // The first fenced block wins.
  const two = block(["task-id: RC-2026-09-24-1"]) + "\n" + block(["task-id: RC-2026-09-24-2"]);
  assert.equal(extractClaimBlock(two), "task-id: RC-2026-09-24-1");
  // The closing fence must start a line.
  assert.equal(extractClaimBlock("```room-claim\nhello ```"), null);
});

test("validateClaimFields is callable on parsed fields directly", () => {
  assert.deepEqual(validateClaimFields({}), [
    "missing task-id", "missing lane", "missing files", "missing lease", "missing state", "missing reason",
  ]);
});

// --- Differential parity against scripts/room's own validate_claim ---

// Pulls the trim/fence/fields/validate_claim defs straight out of
// scripts/room so this test can never drift from the board's validator.
// (fence/fields live in parse_events(); validate_claim lives in
// reduce_state(); both share the same trim def.)
function roomValidatorDefs() {
  const lines = readFileSync(join(checkout, "scripts/room"), "utf8").split("\n");
  const defEnd = start => {
    const end = lines.findIndex((line, i) => i > start && /;\s*$/.test(line));
    assert.ok(end > start, "end of def not found in scripts/room");
    return lines.slice(start, end + 1).join("\n");
  };
  const trim = lines.findIndex(line => /^\s*def trim:/.test(line));
  const fence = lines.findIndex(line => /^\s*def fence\(\$t\):/.test(line));
  const fields = lines.findIndex(line => /^\s*def fields:/.test(line));
  const validate = lines.findIndex(line => /^\s*def validate_claim\(\$b\):/.test(line));
  assert.ok(trim >= 0 && fence > trim && fields > fence && validate > fields, "validator defs not found in scripts/room");
  return [defEnd(trim), defEnd(fence), defEnd(fields), defEnd(validate)].join("\n");
}

const PARITY_VECTORS = [
  VALID,
  "[jill][claim] prose without a fenced block",
  block(["lane: jill", "files: a.mjs", "lease: lease=6h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-9-24-1", "lane: jill", "files: a.mjs", "lease: lease=6h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "files: a.mjs", "lease: lease=6h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "lease: lease=6h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: server/*.mjs", "lease: lease=6h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: 6h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=six-h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=0h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=73h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=007h", "state: working", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=6h", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=6h", "state: done", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=6h", "state: failed(oops_1)", "reason: r"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs", "lease: lease=6h", "state: working"]),
  block(["task-id: RC-2026-09-24-204", "lane: jill", "lane: jill2", "files: a.mjs", "lease: lease=6h", "state: working", "reason: r"]),
  block(["  task-id  : RC-2026-09-24-204  ", "\tlane:\tjill\t", "files: a:b.mjs", "lease: lease=6h", "state: working", "reason: r"]),
  block(["task-id: nope", "files: x/*", "lease: never", "state: ???"]),
  // Bare "failed" is the one intentional ordering deviation from the jq
  // (dead branch in scripts/room: "unknown state word: failed"); the
  // room's stated rule is "failed requires a failure code". Covered by
  // the exact-string tests above, excluded from parity.
];

test("parity with scripts/room validate_claim on every vector", t => {
  let jqAvailable = true;
  try { execSync("command -v jq", { stdio: "ignore" }); } catch { jqAvailable = false; }
  if (!jqAvailable) { t.skip("jq not installed"); return; }
  const program = roomValidatorDefs() + `
    ($body | fence("claim")) as $f
    | if $f == null then { fields: {}, errors: ["no room-claim fenced block found"] }
      else ($f | fields) as $fields | { fields: $fields, errors: ($fields | validate_claim(.)) }
      end`;
  for (const text of PARITY_VECTORS) {
    const res = spawnSync("jq", ["-n", "--arg", "body", text, program], { encoding: "utf8" });
    assert.equal(res.status, 0, `jq failed: ${res.stderr}`);
    const expected = JSON.parse(res.stdout);
    const actual = validateClaimText(text);
    assert.deepEqual(actual.fields, expected.fields, `fields differ for:\n${text}`);
    assert.deepEqual(actual.errors ?? [], expected.errors, `errors differ for:\n${text}`);
    assert.equal(actual.valid, expected.errors.length === 0, `validity differs for:\n${text}`);
  }
});

// --- HTTP wiring ---

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-claim-validate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(origin, body, method = "POST") {
  const res = await fetch(`${origin}/api/claims/validate`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("POST /api/claims/validate answers 200 with the verdict, anonymously", async t => {
  const origin = await serve(t);
  const ok = await post(origin, { text: comment(VALID) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.valid, true);
  assert.equal(ok.json.taskId, "RC-2026-09-24-204");
  assert.equal(ok.json.fields.lane, "jill");
  const bad = await post(origin, { text: comment(block(["task-id: nope", "lease: 6h", "state: working"])) });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.valid, false);
  assert.deepEqual(bad.json.errors, [
    "task-id not RC-YYYY-MM-DD-NNN", "missing lane", "missing files",
    "lease must be lease=<N>h (1-72h); did you mean lease=6h?", "missing reason",
  ]);
});

test("malformed request bodies are 422, non-POST is 405", async t => {
  const origin = await serve(t);
  for (const body of [{}, { text: 42 }, { text: "x", extra: 1 }]) {
    const res = await post(origin, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.json.error.code, "invalid_claim_text");
  }
  const res = await post(origin, undefined, "GET");
  assert.equal(res.status, 405);
});

test("text over 64KB is 422", async t => {
  const origin = await serve(t);
  assert.equal(CLAIM_TEXT_MAX_LENGTH, 65536);
  const res = await post(origin, { text: "x".repeat(CLAIM_TEXT_MAX_LENGTH + 1) });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, "text_too_long");
  const edge = await post(origin, { text: "x".repeat(CLAIM_TEXT_MAX_LENGTH) });
  assert.equal(edge.status, 200); // length is the bound; the verdict is just "no block found"
  assert.deepEqual(edge.json.errors, ["no room-claim fenced block found"]);
});

test("secret-looking block content is never logged", async t => {
  const origin = await serve(t);
  const marker = "rak_claimvalidate_probe_9f8e7d6c5b4a";
  const seen = [];
  const methods = ["log", "warn", "error", "debug", "info"];
  const originals = methods.map(name => [name, console[name]]);
  for (const [name] of originals) console[name] = (...args) => { seen.push(args.map(String).join(" ")); };
  try {
    validateClaimText(comment(block([
      "task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs",
      "lease: lease=6h", "state: working", `reason: ${marker}`,
    ])));
    await post(origin, { text: comment(block([
      "task-id: RC-2026-09-24-204", "lane: jill", "files: a.mjs",
      "lease: lease=6h", "state: working", `reason: ${marker}`,
    ])) });
    await post(origin, { text: "not a string body" }); // 200, no block
    await post(origin, {}); // 422 path — still must not echo the body
  } finally {
    for (const [name, fn] of originals) console[name] = fn;
  }
  assert.ok(seen.every(line => !line.includes(marker)),
    `console captured block content: ${seen.find(line => line.includes(marker))}`);
});

test("the route is bounded at 30 per address per minute", async t => {
  const origin = await serve(t);
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await post(origin, { text: "hello" })).status);
  assert.ok(statuses.slice(0, 30).every(status => status === 200), "the first 30 pass");
  assert.equal(statuses[30], 429, "the 31st is rate limited");
});
