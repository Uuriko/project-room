// MGMT-PANEL Slice 1: operator room list + per-room export
// (server/operator-rooms.mjs, server/operator-routes.mjs).
// Covers: list sorted by live projection size with cap %, archived and
// protected flags (MF-8); live-room export friction — typed room id plus a
// reason stored in the audit row (MF-6); archived-room one-click export;
// the recursive event-JSON token scrub and its out-of-band marker (MF-7);
// the room_export audit row written for every export; and the operator
// gate's 404 shape for both new routes.
import { describe, test, before as beforeSuite, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { scrubEventTokens, sanitizeCell } from "../server/room-export.mjs";
import { listOperatorRooms, operatorRoomExport } from "../server/operator-rooms.mjs";

const TOKEN = "operator-rooms-token-0123456789abcdef";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-op-rooms-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  store.initialize(initialRoom("invite-only-pilot"));
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = (body, prefix = "m") => {
    clock += 10_000;
    store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `${prefix}-${randomUUID()}`, body } });
  };
  const get = async (path, { token = TOKEN } = {}) => {
    const response = await fetch(`${origin}${path}`, { headers: token ? { Authorization: `Operator ${token}` } : {} });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, headers: response.headers, text, json };
  };
  const actions = () => store.db.prepare("SELECT action, target_id, reason, counts_json, result FROM operator_actions ORDER BY at, rowid").all();
  return { store, owner, post, get, actions, tick: () => { clock += 10_000; } };
}

describe("operator rooms list", { concurrency: false }, () => {
  beforeSuite(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("rooms are sorted by live projection size, descending, with cap and flags", async t => {
    const f = await serve(t);
    f.post("x".repeat(4000));
    const res = await f.get("/api/operator/rooms");
    assert.equal(res.status, 200, res.text);
    const rooms = res.json.rooms;
    assert.equal(rooms.length, 2);
    assert.equal(rooms[0].id, "commons", "the room with posts is the largest");
    assert.ok(rooms[0].projectionBytes > rooms[1].projectionBytes);
    assert.equal(rooms[0].capBytes, PILOT_LIMITS.projectionBytes);
    assert.ok(Math.abs(rooms[0].percentOfCap - rooms[0].projectionBytes / rooms[0].capBytes) < 1e-9);
    assert.equal(rooms[0].archived, false);
    assert.equal(rooms[0].protected, false);
    assert.equal(rooms[0].activeMembersByKind.human, 1);
    assert.equal(rooms[0].title, "Project Room Commons");
    assert.ok(rooms[0].headSeq >= 3);
    const pilot = rooms.find(room => room.id === "invite-only-pilot");
    assert.equal(pilot.protected, true, "MF-8: the builtin protected room is flagged");
    assert.equal(res.json.truncated, false);
    assert.equal(typeof res.json.readAt, "number");
    assert.equal(f.actions().length, 0, "a read-only list writes no audit row");
  });

  test("the largest room by the list equals roomsPastLine's top room on the same store", async t => {
    const f = await serve(t);
    f.post("y".repeat(8000));
    const listed = listOperatorRooms(f.store, null);
    const reliefTop = f.store.db.prepare(`SELECT id FROM rooms WHERE length(CAST(projection AS BLOB)) > ?
      ORDER BY length(CAST(projection AS BLOB)) DESC LIMIT ?`).all(0, 1).map(row => row.id);
    assert.equal(listed.rooms[0].id, reliefTop[0]);
    assert.equal(listed.rooms[0].id, "commons");
  });

  test("limit is validated and truncation is reported", async t => {
    const f = await serve(t);
    const capped = await f.get("/api/operator/rooms?limit=1");
    assert.equal(capped.status, 200);
    assert.equal(capped.json.rooms.length, 1);
    assert.equal(capped.json.truncated, true);
    for (const bad of ["0", "501", "1.5", "abc"]) {
      const res = await f.get(`/api/operator/rooms?limit=${bad}`);
      assert.equal(res.status, 422, bad);
      assert.equal(res.json.error.code, "invalid_limit");
    }
  });
});

describe("operator room export", { concurrency: false }, () => {
  beforeSuite(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("a live room refuses export without the typed id and a reason, and writes no audit row", async t => {
    const f = await serve(t);
    f.post("hello");
    for (const path of [
      "/api/operator/rooms/commons/export",
      "/api/operator/rooms/commons/export?confirmRoomId=wrong-id&reason=check",
      "/api/operator/rooms/commons/export?confirmRoomId=commons",
      "/api/operator/rooms/commons/export?confirmRoomId=commons&reason="
    ]) {
      const res = await f.get(path);
      assert.equal(res.status, 422, `${path} -> ${res.text}`);
      assert.ok(["confirmation_required", "reason_required"].includes(res.json.error.code), res.json.error.code);
    }
    assert.equal(f.actions().filter(row => row.action === "room_export").length, 0);
  });

  test("a live room exports with typed id + reason; the reason lands in the audit row and the scrub marker is out-of-band", async t => {
    const f = await serve(t);
    const secret = "pri_abcdefgh12345678";
    f.post(`token ${secret} and rak_12345678abcdefgh nested`);
    const res = await f.get("/api/operator/rooms/commons/export?confirmRoomId=commons&reason=cap%20diagnosis");
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get("x-room-export-scrub"), "token-shapes");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="room-commons-\d{8}-seq\d+\.jsonl"$/);
    assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(res.text));
    assert.ok(!res.text.includes(secret), "the raw token shape must not leave");
    assert.ok(res.text.includes(sha256(secret)), "the token shape is replaced by its sha256");
    const lines = res.text.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(lines.length >= 3);
    assert.ok(lines.every(line => Number.isInteger(line.sequence) && line.event && typeof line.event === "object"),
      "every line is a {sequence, event} line — no in-band scrub marker line");
    const audit = f.actions().filter(row => row.action === "room_export").at(-1);
    assert.equal(audit.target_id, "commons");
    assert.equal(audit.reason, "cap diagnosis");
    assert.equal(audit.result, "ok");
    const counts = JSON.parse(audit.counts_json);
    assert.equal(counts.format, "jsonl");
    assert.equal(counts.events, lines.length);
    assert.equal(counts.bytes, Buffer.byteLength(res.text));
    assert.equal(counts.scrubbed, true);
  });

  test("an archived room exports in one click, in JSONL and HTML", async t => {
    const f = await serve(t);
    f.post("before archive");
    f.tick();
    f.store.command(f.owner, "commons", { id: randomUUID(), type: T.ROOM_ARCHIVED, data: { reason: "Pilot ended" } });
    const jsonl = await f.get("/api/operator/rooms/commons/export");
    assert.equal(jsonl.status, 200, jsonl.text);
    assert.ok(jsonl.text.includes("before archive"));
    const html = await f.get("/api/operator/rooms/commons/export?format=html");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.ok(html.headers.get("content-security-policy"));
    assert.ok(html.text.includes("before archive"));
    const audits = f.actions().filter(row => row.action === "room_export");
    assert.equal(audits.length, 2);
    assert.equal(audits[0].reason, null, "an archived export needs no reason");
    // The operator export appends no room event (it is not a member act).
    assert.equal(f.store.room("commons").sequence, jsonl.json?.sequence ?? f.store.room("commons").sequence);
    const types = [...f.store.db.prepare("SELECT json_extract(body,'$.type') AS type FROM events WHERE room_id='commons'").all()].map(row => row.type);
    assert.ok(!types.includes("room.exported"), "no room.exported event is appended by the operator export");
  });

  test("unknown rooms and bad formats are refused before any audit row", async t => {
    const f = await serve(t);
    const missing = await f.get("/api/operator/rooms/no-such-room/export?confirmRoomId=no-such-room&reason=x");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "room_not_found");
    const badFormat = await f.get("/api/operator/rooms/commons/export?format=pdf&confirmRoomId=commons&reason=x");
    assert.equal(badFormat.status, 422);
    assert.equal(badFormat.json.error.code, "invalid_format");
    assert.equal(f.actions().filter(row => row.action === "room_export").length, 0);
  });

  test("both new routes 404 without the operator token, like an unknown path", async t => {
    const f = await serve(t);
    for (const path of ["/api/operator/rooms", "/api/operator/rooms/commons/export"]) {
      const wrong = await f.get(path, { token: "wrong-token-0123456789abcdef0123" });
      assert.equal(wrong.status, 404, path);
      const none = await f.get(path, { token: null });
      assert.equal(none.status, 404, path);
    }
  });

  test("the parameterised export route does not shadow the exact operator routes", async t => {
    const f = await serve(t);
    const status = await f.get("/api/operator/status");
    assert.equal(status.status, 200);
    const actions = await f.get("/api/operator/actions");
    assert.equal(actions.status, 200);
    const roomsPath = await f.get("/api/operator/rooms/export");
    assert.equal(roomsPath.status, 404, "a non-export suffix under rooms/ is not a route");
  });
});

test("scrubEventTokens scrubs token shapes at nesting depth, in arrays and keys, and nothing else", () => {
  const secret = "ga1.abcdefgh12345678";
  const input = {
    plain: "leave me",
    nested: { deep: [{ value: `x ${secret} y` }, 42, null, true] },
    [`key-${secret}`]: "rak_87654321abcdefgh"
  };
  const out = scrubEventTokens(input);
  assert.equal(out.plain, "leave me");
  assert.equal(out.nested.deep[0].value, `x ${sha256(secret)} y`);
  assert.equal(out.nested.deep[1], 42);
  assert.equal(out.nested.deep[2], null);
  assert.equal(out[`key-${sha256(secret)}`], sha256("rak_87654321abcdefgh"));
  assert.ok(!JSON.stringify(out).includes(secret));
  // Not oversold: a string that merely resembles a prefix passes verbatim.
  assert.equal(scrubEventTokens("sk-live-not-our-shape"), "sk-live-not-our-shape");
  assert.equal(scrubEventTokens(7), 7);
});

test("scrubEventTokens scrubs the L08-C5 credential shapes, not only the product's own tokens", () => {
  // All specimens are obviously synthetic / public documentation examples.
  const specimens = {
    ghp: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    bearer: "syntheticBearerTokenValue1234567890",
    akia: "AKIAIOSFODNN7EXAMPLE",
    password: "hunter2-correct-horse-synthetic",
    jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.syntheticSignatureSegment123",
    session: "syntheticSessionCookieValue0123456789abcdef"
  };
  const input = {
    ghp: `token is ${specimens.ghp} ok`,
    bearer: `Authorization: Bearer ${specimens.bearer}`,
    aws: `aws key ${specimens.akia} here`,
    passwordKey: { password: specimens.password },
    passwordProse: `password: ${specimens.password}`,
    jwt: `jwt ${specimens.jwt} end`,
    sessionKey: { cookie: `session=${specimens.session}; HttpOnly` },
    sessionProse: `Cookie: sessionid=${specimens.session}; Path=/`
  };
  const out = JSON.stringify(scrubEventTokens(input));
  for (const [name, specimen] of Object.entries(specimens))
    assert.ok(!out.includes(specimen), `${name} specimen must not survive scrubbing verbatim`);
  // Scrubbed secrets are sha256 hex, so exports stay correlatable.
  assert.ok(out.includes(sha256(specimens.ghp)));
  assert.ok(out.includes(sha256(specimens.password)));
  // Plain prose that merely mentions the concepts is not a credential.
  const prose = "the bearer of this message discussed password policy and session length";
  assert.equal(scrubEventTokens(prose), prose);
  assert.equal(scrubEventTokens({ author: "Jane Doe" }).author, "Jane Doe");
});

test("scrubEventTokens and sanitizeCell scrub the F1-Q1 cure shapes (recheck of #5524)", () => {
  // All specimens are obviously synthetic / public documentation examples.
  const specimens = {
    spacedPassword: "correct horse battery staple synthetic",
    delimiterPassword: "p@ss,word;synthetic2026",
    urlPassword: "Sup3rSecretPw99",
    dbPassword: "DbPassw0rdSynthetic",
    legacySk: "sk-SyntheticLegacyKey0123456789abcdefghijklmnop",
    anthropicSk: "sk-ant-api03-SyntheticValue0123456789abcdefghij",
    webhookSecret: "xYz9AbC8dEf7GhI3jKl5MnOp",
    sendgrid: "SG.SyntheticSegment1Value.SyntheticSegment2Value0123456789",
    npm: "npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    vault: "hvs.CAESIJsyntheticvalue0123456789abcdef",
    telegram: "123456789:AAESyntheticBotTokenValue0123456789ab",
    awsSecret: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    passphrase: "correct-horse-synthetic-9",
    dbPass: "DbSyntheticPass98765",
    privateKeyBody: "MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCsynthetic",
    jwtPayload: "eyJzdWIiOiIxMjM0NTY3ODkwIn0"
  };
  const prose = [
    `password: ${specimens.spacedPassword}`,
    `password="${specimens.delimiterPassword}"`,
    `clone https://deploy:${specimens.urlPassword}@api.example.invalid/repo.git now`,
    `db postgres://roomuser:${specimens.dbPassword}@db.example.invalid:5432/room end`,
    `openai key ${specimens.legacySk} here`,
    `key ${specimens.anthropicSk} here`,
    `deploy hook https://hooks.slack.com/services/T0SYNTHETIC/B0SYNTHETIC/${specimens.webhookSecret} end`,
    `sg ${specimens.sendgrid} here`,
    `npm ${specimens.npm} here`,
    `vault ${specimens.vault} end`,
    `bot ${specimens.telegram} here`,
    `aws_secret_access_key = ${specimens.awsSecret}`,
    `jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${specimens.jwtPayload} end`
  ].join("\n");
  const keyed = {
    passphrase: specimens.passphrase,
    dbPass: specimens.dbPass,
    privateKey: specimens.privateKeyBody,
    aws_secret_access_key: specimens.awsSecret
  };
  for (const [path, out] of [
    ["event", JSON.stringify(scrubEventTokens({ prose, keyed }))],
    ["cell", sanitizeCell("events", "body", JSON.stringify({ prose, keyed }))],
    ["cell-flat", sanitizeCell("events", "body", prose)]
  ]) {
    for (const [name, specimen] of Object.entries(specimens))
      assert.ok(!out.includes(specimen), `${path}: ${name} specimen must not survive scrubbing verbatim`);
  }
  // Correlatability: a spaced password hashes whole, identically in prose.
  assert.ok(scrubEventTokens(`password: ${specimens.spacedPassword}`).includes(sha256(specimens.spacedPassword)));
});

test("sanitizeCell applies the event path's key-name whole-hashing to JSON text (F1-Q6 parity)", () => {
  const cell = value => sanitizeCell("events", "body", JSON.stringify(value));
  // D1/D2: bare values under credential keys, incl. compound key names.
  assert.ok(!cell({ authorization: "BareSyntheticCredential0123456789" }).includes("BareSyntheticCredential0123456789"));
  assert.ok(!cell({ tokenValue: "bare-synthetic-value-0123456789" }).includes("bare-synthetic-value-0123456789"));
  // D3/D4: arrays and nested objects under a credential key.
  assert.ok(!cell({ token: ["alpha-synthetic-value", "beta-synthetic-value"] }).includes("alpha-synthetic-value"));
  assert.ok(!cell({ token: { nested: "bare-synthetic-value-0123456789" } }).includes("bare-synthetic-value-0123456789"));
  // D5/D7: the emitted hash is the event path's whole-value hash of the
  // unescaped string, for delimiter and spaced values alike.
  for (const value of ["p@ss,word;synthetic2026", "correct horse battery staple"])
    assert.ok(cell({ token: value }).includes(sha256(value)), `cell hash must equal whole-value hash for ${value}`);
  assert.ok(sanitizeCell("events", "body", '{"pass\\u0077ord": "bare-synthetic-value-0123456789"}').includes(sha256("bare-synthetic-value-0123456789")));
  // D6: short values under a credential key are hashed; "" stays "".
  assert.ok(!cell({ token: "abc" }).includes('"abc"'));
  assert.ok(cell({ token: "" }).includes('""'));
  // D8: an object handed to sanitizeCell gets the event scrub, not passthrough.
  assert.ok(!JSON.stringify(sanitizeCell("events", "payload", { token: "bare-synthetic-value-0123456789" })).includes("bare-synthetic-value-0123456789"));
  // D9: a Cookie: string inside a JSON cell no longer swallows later fields.
  const cookieRow = cell({ note: "Cookie: abcdefghijklmnop", after: "AFTERFIELDVALUE" });
  assert.ok(cookieRow.includes("AFTERFIELDVALUE") && !cookieRow.includes("abcdefghijklmnop"));
  // D11: sid is a credential key in the event path too.
  assert.ok(!JSON.stringify(scrubEventTokens({ sid: "bare-synthetic-value-0123456789" })).includes("bare-synthetic-value-0123456789"));
  // Preservation controls.
  assert.ok(cell({ author: "Jane Doe" }).includes("Jane Doe"));
  assert.equal(sanitizeCell("events", "body", "plain prose, no secrets"), "plain prose, no secrets");
});

test("operatorRoomExport materialises a synthetic room whose projection is padded to the cap", { timeout: 180_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-op-rooms-cap-"));
  // The flood guard refills on the store clock; step it per post, as the
  // operator-archive suite does.
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  // 60 messages of 60,000 chars: the event log (and the export) is
  // several MiB, at the scale of a room at the 4 MiB projection cap.
  for (let i = 0; i < 60; i++) {
    clock += 10_000;
    store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `cap-${i}`, body: "z".repeat(60_000) } });
  }
  const result = operatorRoomExport(store, "commons", { confirmRoomId: "commons", reason: "cap load test" }, "req-cap");
  assert.ok(result.body.length > 3 * 1024 * 1024, `export bytes ${result.body.length}`);
  assert.equal(result.events, 62);
  const lines = result.body.toString("utf8").trim().split("\n");
  assert.equal(lines.length, 62);
  assert.ok(lines.every(line => { const row = JSON.parse(line); return Number.isInteger(row.sequence) && row.event; }));
});
