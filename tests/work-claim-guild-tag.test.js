// FIX-10 (WAVE-300): federated guilds — smallest slice. The guild tag is set
// once at create (validated, persisted, orthogonal to the state machine),
// and the board list gains a `?guild=` read projection whose cursors bind to
// the guild like they bind to state. Everything is additive: untagged claims
// behave exactly as before, and no existing query changes meaning.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWork, guildOf, ClaimError } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { buildWorkClaimPage } from "../server/work-claim-routes.mjs";
import { ServiceError } from "../server/service-error.mjs";

const NOW = Date.UTC(2026, 9, 9, 20, 0, 0);
const mk = (id, guild) => createWork({ id, guild }, { now: NOW, agentId: "agent" });
const page = (items, query) => buildWorkClaimPage(items, "room", "viewer", new URLSearchParams(query), NOW);

test("guildOf: validates the tag, null for absent", () => {
  assert.equal(guildOf(undefined), null);
  assert.equal(guildOf(null), null);
  assert.equal(guildOf(""), null);
  assert.equal(guildOf("build-guild_1"), "build-guild_1");
  assert.throws(() => guildOf("has space"), ClaimError);
  assert.throws(() => guildOf("semi;colon"), ClaimError);
  assert.throws(() => guildOf("x".repeat(65)), ClaimError);
  assert.throws(() => guildOf(42), ClaimError);
});

test("createWork: guild stored on the item, absent means the flat model", () => {
  const tagged = mk("a", "g1");
  assert.equal(tagged.guild, "g1");
  assert.equal(tagged.state, "unclaimed");
  assert.equal(mk("b").guild, null, "no guild is the flat model, unchanged");
  assert.throws(() => mk("c", "bad guild"), ClaimError);
});

test("guild survives durable sqlite round-trip", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  registry.set("room", mk("a", "g1"));
  registry.set("room", mk("b"));
  assert.equal(registry.get("room", "a").guild, "g1");
  assert.equal(registry.get("room", "b").guild, null, "legacy rows decode to null, never undefined");
});

test("?guild= projects only that guild's claims", () => {
  const items = [mk("a", "g1"), mk("b", "g2"), mk("c")];
  const one = page(items, "guild=g1");
  assert.deepEqual(one.claims.map(c => c.id), ["a"]);
  const all = page(items, "");
  assert.deepEqual(all.claims.map(c => c.id).sort(), ["a", "b", "c"], "no guild filter keeps the flat board");
});

test("?guild= rejects an invalid guild tag with 422", () => {
  assert.throws(() => page([mk("a", "g1")], "guild=bad+guild"),
    error => error instanceof ServiceError && error.status === 422);
  assert.throws(() => page([mk("a", "g1")], "guild=&guild=g1"),
    error => error instanceof ServiceError && error.status === 422, "duplicate guild params rejected");
});

test("guild-scoped cursors bind to the guild like state cursors", () => {
  const items = [mk("a", "g1"), mk("b", "g1"), mk("c", "g2")];
  const first = page(items, "guild=g1&limit=1");
  assert.equal(first.claims.length, 1);
  assert.ok(first.nextCursor, "more g1 claims remain");
  const second = page(items, `guild=g1&limit=1&cursor=${first.nextCursor}`);
  assert.deepEqual(second.claims.map(c => c.id), ["b"], "continuation stays inside the guild");
  // A guild cursor on the flat board is rejected, not silently re-scoped.
  assert.throws(() => page(items, `limit=1&cursor=${first.nextCursor}`),
    error => error instanceof ServiceError && error.status === 422);
  // A legacy (guildless) cursor on a guild page is rejected too.
  const legacy = Buffer.from(JSON.stringify({ u: "2026-10-09T20:00:00.000Z", i: "a", s: null }), "utf8").toString("base64url");
  assert.throws(() => page(items, `guild=g1&cursor=${legacy}`),
    error => error instanceof ServiceError && error.status === 422);
  // A guild cursor for a different guild is rejected.
  assert.throws(() => page(items, `guild=g2&cursor=${first.nextCursor}`),
    error => error instanceof ServiceError && error.status === 422);
});

test("?guild= composes with state and the ready queue", () => {
  const items = [mk("a", "g1"), mk("b", "g1"), mk("c", "g2")];
  const statePage = page(items, "guild=g1&state=unclaimed");
  assert.deepEqual(statePage.claims.map(c => c.id).sort(), ["a", "b"]);
  const ready = page(items, "guild=g2&queue=ready");
  assert.deepEqual(ready.claims.map(c => c.id), ["c"]);
});
