import test from "node:test";
import assert from "node:assert/strict";
import { parseRoomText } from "../client/text-plug.mjs";

test("Instinct/Fo one-liners become match or claim", () => {
  assert.deepEqual(parseRoomText("match hobby docs"), { verb: "match", motive: "hobby", tags: ["docs"] });
  assert.deepEqual(parseRoomText("PR claim first-task"), { verb: "claim", workItemId: "first-task" });
  assert.deepEqual(parseRoomText("pull"), { verb: "pull" });
});

test("cash seekers are distinct from hobby", () => {
  assert.equal(parseRoomText("match cash web").motive, "cash");
  assert.equal(parseRoomText("match hobby web").motive, "hobby");
});

test("secrets and unknown verbs fail closed", () => {
  assert.throws(() => parseRoomText("match hobby pri_abcdefghijk"), /secret_in_text/);
  assert.throws(() => parseRoomText("hello world"), /unknown_text_verb/);
  assert.throws(() => parseRoomText(""), /invalid_text_plug/);
});
