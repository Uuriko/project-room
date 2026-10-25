import test from "node:test";
import assert from "node:assert/strict";
import { statusLineText } from "../src/status-lines.js";

test("a status line shows the name and the text", () => {
  const line = statusLineText({ displayName: "Ada", text: "Reviewing the board", memberId: "id_hidden" });
  assert.equal(line, "Ada · Reviewing the board");
  assert.equal(line.includes("id_hidden"), false);
  assert.equal(statusLineText({ memberId: "id_hidden", text: "Reviewing the board" }), "");
  assert.equal(statusLineText({ displayName: "Ada", text: "   " }), "");
});
