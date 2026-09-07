import test from "node:test";
import assert from "node:assert/strict";
import { sendsOnEnter } from "../src/conversation.js";

test("desktop Enter sends; touch Return and Shift+Enter insert lines", () => {
  assert.equal(sendsOnEnter({ key: "Enter" }), true);
  assert.equal(sendsOnEnter({ key: "Enter" }, true), false);
  for (const touch of [true, false]) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      assert.equal(sendsOnEnter({ key: "Enter", [modifier]: true }, touch), true);
      assert.equal(sendsOnEnter({ key: "Enter", [modifier]: true, shiftKey: true }, touch), false);
    }
  }
});

test("composition, legacy IME, repeat, Alt and other keys never send", () => {
  for (const touch of [true, false]) {
    for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { shiftKey: true }, { key: "a" }]) {
      assert.equal(sendsOnEnter({ key: "Enter", ctrlKey: true, ...guard }, touch), false);
    }
  }
});
