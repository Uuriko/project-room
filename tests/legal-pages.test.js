// Public terms, privacy, abuse reports, and operator unpublish.
// HTTP coverage for server/legal-pages.mjs, server/legal-routes.mjs, and server/legal-store.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { TERMS_VERSION } from "../server/legal-store.mjs";
import { EMBEDDED_LEGAL } from "../server/legal-documents.mjs";
import { collectPublicReceipts } from "../server/receipts-live.mjs";

const HASH = `sha256:${"ab".repeat(32)}`;
const PWR = `pwr_${"cd".repeat(32)}`;
const OPERATOR_EMAIL = "legal-operator@example.invalid";
const OPERATOR_PASSWORD = "legal-operator-password";
const OTHER_EMAIL = "legal-other@example.invalid";
const OTHER_PASSWORD = "legal-other-password";

const operatorAccountId = `email:${createHash("sha256").update(OPERATOR_EMAIL).digest("hex")}`;

function solveProof(challenge, kind, target) {
  const prefix = "0".repeat(challenge.bits / 4);
  for (let i = 0; i < 200000; i++) {
    const nonce = `n${i.toString(36)}`;
    const digest = createHash("sha256").update(`${challenge.bucket}:${kind}:${target}:${nonce}`).digest("hex");
    if (digest.startsWith(prefix)) return nonce;
  }
  throw new Error("no proof");
}

async function serve(t, { operator = operatorAccountId } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-legal-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, operatorAccountId: operator });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, store, ownerKey };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const cookieOf = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") || "")?.[1] ?? null;

async function signup(origin, store, email, password) {
  const slot = store.createAccountSessionSlot();
  const res = await raw(origin, "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  const body = JSON.parse(res.text);
  return { status: res.status, body, cookie: cookieOf(res) };
}

async function login(origin, store, email, password) {
  const slot = store.createAccountSessionSlot();
  const res = await raw(origin, "/api/auth/password/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  return { status: res.status, body: JSON.parse(res.text), cookie: cookieOf(res) };
}

test("legal pages are cacheable, indexed, and listed in the sitemap", async t => {
  const { origin } = await serve(t, { operator: "" });
  for (const path of ["/terms", "/privacy", "/subprocessors", "/acceptable-use", "/legal"]) {
    const page = await raw(origin, path);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get("cache-control"), "public, max-age=3600", path);
    assert.equal(page.headers.get("x-robots-tag"), "all", path);
    assert.match(page.text, new RegExp(TERMS_VERSION));
    assert.match(page.text, /Demigod Labs, Inc\./);
  }
  const terms = await raw(origin, "/terms");
  assert.match(terms.text, /potter@trydemigod\.com/);
  assert.match(terms.text, /Delaware/);
  const privacy = await raw(origin, "/privacy");
  assert.match(privacy.text, /scrypt/);
  assert.match(privacy.text, /account_session/);
  assert.match(privacy.text, /cookieless/);
  const subprocessors = await raw(origin, "/subprocessors");
  for (const name of ["Cloudflare, Inc.", "Resend, Inc.", "Google LLC", "GitHub, Inc.", "Microsoft Corporation", "Firecrawl", "Telegram FZ-LLC"]) {
    assert.match(subprocessors.text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const previousContact = process.env.ROOM_SECURITY_CONTACT;
  process.env.ROOM_SECURITY_CONTACT = "potter@trydemigod.com";
  t.after(() => {
    if (previousContact === undefined) delete process.env.ROOM_SECURITY_CONTACT;
    else process.env.ROOM_SECURITY_CONTACT = previousContact;
  });
  const security = await raw(origin, "/.well-known/security.txt");
  assert.equal(security.status, 200);
  assert.match(security.text, /Contact: mailto:potter@trydemigod\.com/);
  assert.equal(security.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal((await raw(origin, "/security.txt")).text, security.text);
  const sitemap = await raw(origin, "/sitemap.xml");
  assert.equal(sitemap.status, 200);
  for (const path of ["/terms", "/privacy", "/subprocessors", "/acceptable-use", "/legal"]) {
    assert.match(sitemap.text, new RegExp(path.replace("/", "\\/")));
  }
  const denied = await raw(origin, "/terms", { method: "POST" });
  assert.equal(denied.status, 405);
  for (const name of ["terms.md", "privacy.md", "acceptable-use.md", "subprocessors.json"]) {
    assert.equal(EMBEDDED_LEGAL[name], readFileSync(new URL(`../docs/legal/${name}`, import.meta.url), "utf8"));
  }
});

test("signup records the terms version and a later version must be accepted", async t => {
  const { origin, store } = await serve(t, { operator: "" });
  const created = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  assert.equal(created.status, 201);
  assert.equal(created.body.terms.version, TERMS_VERSION);
  assert.equal(created.body.terms.acceptedVersion, TERMS_VERSION);
  assert.equal(created.body.terms.required, false);
  const row = store.db.prepare("SELECT terms_version, accepted_at FROM account_terms WHERE account_id=?").get(created.body.account.id);
  assert.equal(row.terms_version, TERMS_VERSION);
  assert.equal(typeof row.accepted_at, "number");
  store.db.prepare("UPDATE account_terms SET terms_version=? WHERE account_id=?").run("2020-01-01", created.body.account.id);
  const again = await login(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  assert.equal(again.status, 200);
  assert.equal(again.body.terms.required, true);
  assert.equal(again.body.terms.acceptedVersion, "2020-01-01");
  const stale = await raw(origin, "/api/account/terms", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${again.cookie}`, "X-CSRF-Token": again.body.csrf },
    body: JSON.stringify({ version: "2020-01-01" }),
  });
  assert.equal(stale.status, 409);
  assert.equal(JSON.parse(stale.text).error.code, "terms_changed");
  const accepted = await raw(origin, "/api/account/terms", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${again.cookie}`, "X-CSRF-Token": again.body.csrf },
    body: JSON.stringify({ version: TERMS_VERSION }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.text).terms.required, false);
  assert.equal(JSON.parse(accepted.text).terms.acceptedVersion, TERMS_VERSION);
  const fresh = await login(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  assert.equal(fresh.body.terms.required, false);
});

test("a public report needs proof of work, is rate-limited, and stores an IP hash", async t => {
  const { origin, store } = await serve(t, { operator: "" });
  const extra = await raw(origin, "/api/reports/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "room", target: "commons", body: "nope", bucket: 1, nonce: "n0", surprise: true }),
  });
  assert.equal(extra.status, 422);
  const missing = await raw(origin, "/api/reports/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 428);
  assert.equal(JSON.parse(missing.text).error.code, "proof_required");
  const challenge = JSON.parse((await raw(origin, "/api/reports/public/challenge")).text);
  const target = "commons";
  const postReport = async () => {
    const nonce = solveProof(challenge, "room", target);
    return raw(origin, "/api/reports/public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "room", target, body: "This public room should be reviewed.", bucket: challenge.bucket, nonce }),
    });
  };
  const stored = [];
  for (let i = 0; i < 3; i++) stored.push(await postReport());
  assert.equal(stored.every(item => item.status === 201), true);
  const blocked = await postReport();
  assert.equal(blocked.status, 429);
  const rows = store.db.prepare("SELECT * FROM public_abuse_reports").all();
  assert.equal(rows.length, 3);
  const expectedHash = createHash("sha256").update("project-room-public-report:127.0.0.1").digest("hex");
  for (const row of rows) {
    assert.equal(Object.hasOwn(row, "ip"), false);
    assert.equal(JSON.stringify(row).includes("127.0.0.1"), false);
    assert.equal(row.ip_hash, expectedHash);
    assert.equal(row.status, "open");
  }
  const jobs = JSON.parse((await raw(origin, "/api/health/jobs")).text);
  assert.equal(jobs.schema, "room.job-health/1");
  assert.equal(jobs.publicReports, 3);
  assert.equal(jobs.servedBy, "node");
  assert.equal(Object.hasOwn(jobs, "status"), false);
});

test("unpublish removes a room and a receipt from public reads and the sitemap", async t => {
  const { origin, store, ownerKey } = await serve(t);
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  store.workClaims.set("commons", {
    id: "claim-1", title: "Ship the door", state: "done", owner: "ada",
    history: [{ action: "pr_merged", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [HASH], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    PWR, "offer-1", "commons", 1, "ai_public", "note", "cd".repeat(32), 4,
    JSON.stringify({ schema: "public-work-receipt/1", receiptId: PWR, namespaceId: "commons", identityId: "ai_public", title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "cd".repeat(32) } }),
    Date.now());
  store.command(ownerKey, "commons", { id: "page-on", type: "room.public_page_set", data: { enabled: true } });
  store.command(ownerKey, "commons", { id: "receipts-on", type: "room.public_receipts_set", data: { enabled: true } });
  store.roomDirectory.set("commons", "owner", true);
  const claimId = collectPublicReceipts(store).find(item => item.title === "Ship the door").id;
  assert.equal((await raw(origin, "/r/commons")).status, 200);
  assert.match((await raw(origin, "/r/commons")).text, /Report/);
  assert.match((await raw(origin, `/receipts/${claimId}`)).text, /Report/);
  assert.match((await raw(origin, "/sitemap.xml")).text, /\/r\/commons/);
  assert.match((await raw(origin, "/api/public/rooms/directory")).text, /commons/);

  const stranger = await signup(origin, store, OTHER_EMAIL, OTHER_PASSWORD);
  assert.equal(stranger.status, 201);
  const denied = await raw(origin, "/api/operator/unpublish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${stranger.cookie}`, "X-CSRF-Token": stranger.body.csrf },
    body: JSON.stringify({ kind: "receipt", id: claimId }),
  });
  assert.equal(denied.status, 403);

  const operator = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  assert.equal(operator.body.account.id, operatorAccountId);
  const hideReceipt = await raw(origin, "/api/operator/unpublish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${operator.cookie}`, "X-CSRF-Token": operator.body.csrf },
    body: JSON.stringify({ kind: "receipt", id: claimId }),
  });
  assert.equal(hideReceipt.status, 200);
  assert.equal((await raw(origin, `/receipts/${claimId}`)).status, 404);
  assert.equal((await raw(origin, `/receipts/${claimId}.json`)).status, 404);
  assert.equal((await raw(origin, "/receipts")).text.includes("Ship the door"), false);
  assert.equal((await raw(origin, "/sitemap.xml")).text.includes(`/receipts/${claimId}`), false);
  assert.equal((await raw(origin, "/r/commons")).status, 200);
  assert.match((await raw(origin, `/receipts/${PWR}`)).text, /Public task/);

  const hideRoom = await raw(origin, "/api/operator/unpublish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${operator.cookie}`, "X-CSRF-Token": operator.body.csrf },
    body: JSON.stringify({ kind: "room", id: "commons" }),
  });
  assert.equal(hideRoom.status, 200);
  assert.equal((await raw(origin, "/r/commons")).status, 404);
  assert.equal((await raw(origin, "/r/commons.json")).status, 404);
  assert.equal((await raw(origin, `/receipts/${PWR}`)).status, 404);
  assert.equal((await raw(origin, "/sitemap.xml")).text.includes("/r/commons"), false);
  assert.equal((await raw(origin, "/sitemap.xml")).text.includes(PWR), false);
  const directory = JSON.parse((await raw(origin, "/api/public/rooms/directory")).text);
  assert.equal(directory.rooms.some(room => room.roomId === "commons"), false);
  store.command(ownerKey, "commons", { id: "page-again", type: "room.public_page_set", data: { enabled: true } });
  assert.equal((await raw(origin, "/r/commons")).status, 404);
});

test("unpublish is refused when no operator account is configured", async t => {
  const { origin, store } = await serve(t, { operator: "" });
  const created = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  const res = await raw(origin, "/api/operator/unpublish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `account_session=${created.cookie}`, "X-CSRF-Token": created.body.csrf },
    body: JSON.stringify({ kind: "room", id: "commons" }),
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.text).error.code, "operator_unconfigured");
});
