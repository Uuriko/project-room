// SEC2: createWork() must bound the create note. The note lands on the
// "created" history stamp and is served on every board list, so an unbounded
// note is a storage/amplification vector for any direct API caller (the
// S3 New-item form caps at 4000 chars, but the API path had no cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, renewWork } from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-04T20:00:00.000Z");
const mk = note => createWork({ id: "n1", title: "T", note }, { now: T0 });
// A claimed item with a live lease, for the update/renew paths.
const owned = id =>
  claimWork(createWork({ id, title: "T" }, { now: T0 }), "quill", { leaseHours: 1, now: T0 });

test("createWork accepts a short string note and stores it on the created stamp", () => {
  const item = mk("context for whoever picks this up");
  assert.equal(item.history[0].action, "created");
  assert.equal(item.history[0].note, "context for whoever picks this up");
});

test("createWork accepts a missing or null note", () => {
  assert.equal(mk(undefined).history[0].note, null);
  assert.equal(mk(null).history[0].note, null);
});

test("createWork accepts a note at the 4000-char form bound", () => {
  assert.equal(mk("x".repeat(4000)).history[0].note.length, 4000);
});

test("createWork rejects an over-long note", () => {
  assert.throws(() => mk("x".repeat(4001)), /at most 4000/);
});

test("createWork rejects a non-string note", () => {
  assert.throws(() => mk({ text: "hi" }), /must be a string/);
  assert.throws(() => mk(42), /must be a string/);
});

// QA D-1 (qaD-fix-notecap): the 4000-char bound must hold on EVERY path that
// stores a note on a history stamp — claim, update, and renew — not just
// create. An unbounded update/renew note is the same storage/amplification
// vector the SEC2 create cap closed (notes are served on every board list).

test("claimWork enforces the same note bound as create", () => {
  const item = createWork({ id: "n2", title: "T" }, { now: T0 });
  const ok = claimWork(item, "quill", { note: "x".repeat(4000), now: T0 });
  assert.equal(ok.history.at(-1).note.length, 4000);
  assert.throws(
    () => claimWork(item, "quill", { note: "x".repeat(4001), now: T0 }),
    /at most 4000/
  );
  assert.throws(
    () => claimWork(item, "quill", { note: { text: "hi" }, now: T0 }),
    /must be a string/
  );
});

test("updateWork enforces the same note bound as create", () => {
  const item = owned("n3");
  const ok = updateWork(item, "quill", { note: "x".repeat(4000), now: T0 });
  assert.equal(ok.history.at(-1).note.length, 4000);
  assert.throws(
    () => updateWork(item, "quill", { note: "x".repeat(4001), now: T0 }),
    /at most 4000/
  );
  assert.throws(() => updateWork(item, "quill", { note: 42, now: T0 }), /must be a string/);
});

test("renewWork enforces the same note bound as create", () => {
  const item = owned("n4");
  assert.throws(
    () => renewWork(item, "quill", { note: "x".repeat(4001), now: T0 }),
    /at most 4000/
  );
  assert.throws(() => renewWork(item, "quill", { note: 42, now: T0 }), /must be a string/);
});

test("updateWork measures the bound in UTF-16 units, like create", () => {
  // Parity pin: the bound is note.length (UTF-16 code units) on every path.
  const item = owned("n5");
  const ok = updateWork(item, "quill", { note: "🪔".repeat(2000), now: T0 });
  assert.equal(ok.history.at(-1).note.length, 4000);
  assert.throws(
    () => updateWork(item, "quill", { note: "🪔".repeat(2001), now: T0 }),
    /at most 4000/
  );
});
