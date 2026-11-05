// D1-5 F1 (methods-audit depth): the genesis credit receipt of every lane
// carries `before: null` — a first movement has no debit leg, so there is no
// prior lot state (server/bounty-escrow.mjs history(): `before` is the debit
// leg's {account, lotState} or null; pinned by bounty-escrow-http.test.js:
// "every non-genesis movement receipt carries before"). The documented
// CreditReceipt schema typed `before` as a plain non-nullable object while
// its sibling fields memo / bountyId / prevHash carry `nullable: true`, so a
// spec-generated client that validates responses fails on essentially every
// non-empty credit-history read. This test validates the LIVE genesis
// receipt against the documented schema, honouring the spec file's own
// nullability conventions (`nullable: true`, or a type list naming "null").
// `after` needs no such admission: history() always resolves it to an object
// (the credit leg, or the movement's own first entry as fallback).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "commons";
const openapi = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const creditReceipt = openapi.components.schemas.CreditReceipt;

// Minimal validator over the CreditReceipt shape: object/string/number
// types, properties/items recursion, local $ref resolution, and the file's
// two nullability spellings. Undeclared receipt fields (amountMillis,
// signedReceiptIds) are admitted — the schema declares no
// additionalProperties: false.
function validate(schema, value, path, errors) {
  if (schema?.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    schema = openapi.components.schemas[name];
    assert.ok(schema, `resolvable $ref at ${path}`);
  }
  if (value === null) {
    const admitsNull = schema?.nullable === true
      || (Array.isArray(schema?.type) && schema.type.includes("null"));
    if (!admitsNull) errors.push(`${path}: null is not admitted by the documented schema`);
    return;
  }
  const types = (Array.isArray(schema?.type) ? schema.type : [schema?.type]).filter(t => t !== "null");
  if (types.length === 0) return;
  const type = types[0];
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
      return;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(sub, value[key], `${path}.${key}`, errors);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
  } else if (type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string, got ${typeof value}`);
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number") errors.push(`${path}: expected ${type}, got ${typeof value}`);
  }
}

async function serveSeeded(t) {
  const fixture = createAcceptanceFixture();
  // Ledger seeding exactly as tests/bounty-escrow-http.test.js startServer():
  // one genesis append per fixture member.
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys };
}

const history = async (origin, secret) => {
  const res = await fetch(`${origin}/api/rooms/${ROOM}/credits/history/producer`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()).receipts;
};

test("genesis credit receipt validates against the documented CreditReceipt schema", async t => {
  const { origin, keys } = await serveSeeded(t);
  const receipts = await history(origin, keys.owner);
  const genesis = receipts.find(r => r.kind === "genesis");
  assert.ok(genesis, "producer history carries the genesis receipt");
  assert.equal(genesis.before, null, "genesis is a credit-only movement: no prior lot state");
  assert.equal(typeof genesis.after, "object", "after always resolves to the credited lot state");
  const errors = [];
  validate(creditReceipt, genesis, "receipt", errors);
  assert.deepEqual(errors, [], `genesis receipt must conform to CreditReceipt: ${errors.join("; ")}`);
});

test("non-genesis receipts validate too (validator control)", async t => {
  const { origin, keys } = await serveSeeded(t);
  const transfer = await fetch(`${origin}/api/rooms/${ROOM}/credits/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${keys.owner}` },
    body: JSON.stringify({ to: "producer", amount: 1, idempotencyKey: "openapi-genesis-1" }),
  });
  assert.equal(transfer.status, 200);
  const receipts = await history(origin, keys.owner);
  const moved = receipts.find(r => r.kind === "transfer");
  assert.ok(moved, "transfer receipt present");
  assert.equal(typeof moved.before, "object", "a transfer has a debit leg, so before is an object");
  const errors = [];
  validate(creditReceipt, moved, "receipt", errors);
  assert.deepEqual(errors, [], `transfer receipt must conform to CreditReceipt: ${errors.join("; ")}`);
});
