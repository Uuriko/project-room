// door-join pack steps 1, 2, 3, 5: join page drafts, no focus seizure, lazy
// room client, and copy that does not assert an unchecked room exists.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readJoinDraft, writeJoinDraft, clearJoinDraft, joinDraftKey, JOIN_DRAFT_FIELDS } from "../src/join.js";

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map };
}

test("drafts round-trip per room, keep only known fields, and clear", () => {
  const storage = memoryStorage();
  writeJoinDraft(storage, "muse-room", { "join-enter-code": "RM-ABC", "join-request-name": "Ada", "join-request-note": "hi", evil: "x" });
  assert.deepEqual(readJoinDraft(storage, "muse-room"), { "join-enter-code": "RM-ABC", "join-request-name": "Ada", "join-request-note": "hi" });
  assert.deepEqual(readJoinDraft(storage, "other-room"), {}, "drafts are keyed per room");
  writeJoinDraft(storage, "muse-room", { "join-enter-code": "" });
  assert.equal(storage.map.has(joinDraftKey("muse-room")), false, "an all-empty draft is removed");
  writeJoinDraft(storage, "muse-room", { "join-request-name": "Ada" });
  clearJoinDraft(storage, "muse-room");
  assert.deepEqual(readJoinDraft(storage, "muse-room"), {});
  assert.deepEqual([...JOIN_DRAFT_FIELDS], ["join-enter-code", "join-request-room", "join-request-name", "join-request-note", "join-request-referred"]);
});

test("draft helpers survive broken or blocked storage", () => {
  const broken = { getItem: () => "{not json", setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(readJoinDraft(broken, "r"), {});
  assert.doesNotThrow(() => writeJoinDraft(broken, "r", { "join-request-name": "Ada" }));
  assert.doesNotThrow(() => clearJoinDraft(broken, "r"));
  assert.deepEqual(readJoinDraft(undefined, "r"), {});
});

test("join.js loads the room client lazily, does not grab focus on load, and does not assert the room exists", () => {
  const source = readFileSync(new URL("../src/join.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import[^;]*from "\.\/client\.js";/m, "no static import of client.js");
  assert.match(source, /await import\("\.\/client\.js"\)/, "client.js is imported inside the request submit handler");
  const renderEnter = source.slice(source.indexOf("function renderEnter()"), source.indexOf("function renderRequestDoor()"));
  const tail = renderEnter.slice(renderEnter.lastIndexOf('show("join-enter")'));
  assert.doesNotMatch(tail, /focus\(/, "renderEnter ends without moving focus");
  assert.match(renderEnter, /\.focus\(\);\n\s+return;/, "the invalid-code correction still focuses the field");
  assert.doesNotMatch(source, /`Room "\$\{room\}" — enter its invite code/, "no sentence asserting the room exists");
});
