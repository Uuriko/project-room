// Mint Retry-After truth (UT2 conversion L1).
//
// Defect at base f01350e8: the anonymous mint budgets refill on a ROLLING
// 24-hour window (a slot frees only when the oldest counted mint ages out),
// but every day-tier refusal hard-codes `Retry-After: 3600` — a caller that
// waits the advertised hour is still refused (executed in UT wave 2 for
// >=2.5h, and at kernel level: refused at t0+3601s, admitted at t0+24h+1s).
// The refusal body carried no numeric retry value at all (the hint names
// "the Retry-After interval" without stating it), the MCP door dropped the
// header and carried no value either, and no refusal disclosed the budget's
// scope, limit, or window — a refused agent could not tell "I minted too
// much" from "my network neighbours did" (UT2 09-02 F-1).
//
// Cure contract pinned here:
// 1. Retry-After = seconds until the oldest mint counted by the tripped
//    tier leaves its window (the earliest instant a retry can succeed).
// 2. Every refusal (kernel error, HTTP body, MCP structuredContent) carries
//    detail { retryAfterSeconds, mintBudget: { scope, limit, windowMs,
//    retryAfterSeconds, resetAt } } with scope address|network|global.
// 3. A retry at the advertised instant succeeds.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentIdentities, anonymousMintBuckets, solveIdentityMintProof } from "../server/agent-identities.mjs";
import { handleIdentityMintMcp } from "../server/mcp-identity-mint.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-06-01T00:00:00Z");

function openStore(now) {
  const directory = mkdtempSync(join(tmpdir(), "mint-retry-truth-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom("commons"));
  return { store, directory };
}
const refusal = fn => { try { fn(); } catch (error) { return error; } assert.fail("expected a refusal"); };
const anon = address => ({ anonymous: { address } });

test("network day tier: Retry-After is the time until the oldest counted mint ages out", () => {
  let now = T0;
  const { store, directory } = openStore(now);
  try {
    const ids = new AgentIdentities(store, {
      anonymousDailyLimit: 30, addressDailyLimit: 30, networkDailyLimit: 2,
      addressMinuteLimit: 30, proofFreePerAddress: 30,
    });
    // Store clock is read through store.now(); advance by rebinding via ids'
    // store — RoomStore keeps the closure, so move time by mutating the
    // holder: this fixture instead seeds the second mint 2h later by
    // backdating the first row, which is equivalent for the window math.
    ids.create("Net One", anon("203.0.113.1"));
    store.db.prepare("UPDATE agent_identities SET created_at=?").run(T0 - 2 * 60 * 60 * 1000);
    ids.create("Net Two", anon("203.0.113.2"));
    const over = refusal(() => ids.create("Net Three", anon("203.0.113.3")));
    assert.equal(over.status, 429);
    assert.equal(over.code, "rate_limited");
    assert.match(over.message, /network budget/);
    // Oldest counted mint is 2h old: a slot frees in 22h, not 3600s.
    assert.equal(over.headers["Retry-After"], "79200",
      "Retry-After must be seconds until the oldest counted mint leaves the rolling 24h window");
    assert.equal(over.detail?.retryAfterSeconds, 79200);
    assert.deepEqual(over.detail?.mintBudget, {
      scope: "network", limit: 2, windowMs: DAY_MS, retryAfterSeconds: 79200, resetAt: T0 - 2 * 60 * 60 * 1000 + DAY_MS,
    });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("minute tier: Retry-After shrinks with the oldest mint's age and the detail names the address scope", () => {
  const { store, directory } = openStore(T0);
  try {
    const ids = new AgentIdentities(store, {
      anonymousDailyLimit: 30, addressDailyLimit: 30, networkDailyLimit: 30,
      addressMinuteLimit: 1, proofFreePerAddress: 30,
    });
    ids.create("Minute One", anon("192.0.2.20"));
    store.db.prepare("UPDATE agent_identities SET created_at=?").run(T0 - 30_000);
    const over = refusal(() => ids.create("Minute Two", anon("192.0.2.20")));
    assert.match(over.message, /Too many identity mints/);
    assert.equal(over.headers["Retry-After"], "30");
    assert.equal(over.detail?.mintBudget?.scope, "address");
    assert.equal(over.detail?.mintBudget?.windowMs, 60_000);
    assert.equal(over.detail?.retryAfterSeconds, 30);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("MCP room_identity_mint refusal carries the numeric retry value and budget scope", () => {
  const { store, directory } = openStore(T0);
  try {
    store.identities.networkDailyLimit = 1;
    const call = name => handleIdentityMintMcp(store, {
      jsonrpc: "2.0", id: "mint-truth", method: "tools/call",
      params: { name: "room_identity_mint", arguments: { displayName: name } },
    }, { remoteAddress: "203.0.113.9" });
    assert.equal(call("MCP One").result.isError, undefined);
    const second = call("MCP Two");
    assert.equal(second.result.isError, true);
    const sc = second.result.structuredContent;
    assert.equal(sc.status, 429);
    assert.equal(sc.detail?.retryAfterSeconds, 86400,
      "the MCP refusal must carry the numeric retry value the HTTP header carries");
    assert.equal(sc.detail?.mintBudget?.scope, "network");
    assert.equal(sc.detail?.mintBudget?.limit, 1);
    assert.equal(sc.detail?.mintBudget?.windowMs, DAY_MS);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP mint refusal: header and body agree, and the body discloses scope, limit and window", async t => {
  const directory = mkdtempSync(join(tmpdir(), "mint-retry-truth-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const buckets = anonymousMintBuckets("127.0.0.1");
  const insert = store.db.prepare(
    "INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at,mint_address,mint_network) VALUES(?,?,?,?,?,?)");
  store.transaction(() => {
    for (let i = 0; i < 20; i++) insert.run(`ai_${randomUUID().replaceAll("-", "")}`, `seed-${randomUUID()}`, "Seed", store.now() - 120_000, buckets.address, buckets.network);
  });
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Over Address", proof: solveIdentityMintProof("Over Address", store.now()) }),
  });
  assert.equal(res.status, 429);
  const header = Number(res.headers.get("retry-after"));
  const body = await res.json();
  assert.match(body.error.message, /address budget/);
  // Oldest seeded mint is ~120s old: the true wait is ~86280s, never 3600.
  assert.ok(header > 86_000 && header <= 86_400, `Retry-After must be the true wait (~86280), got ${header}`);
  assert.equal(body.retryAfterSeconds, header, "the body must carry the same numeric retry value as the header");
  assert.equal(body.mintBudget?.scope, "address");
  assert.equal(body.mintBudget?.limit, 20);
  assert.equal(body.mintBudget?.windowMs, DAY_MS);
  assert.equal(body.mintBudget?.retryAfterSeconds, header);
});
