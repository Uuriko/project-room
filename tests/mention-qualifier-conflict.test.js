import test from "node:test";
import assert from "node:assert/strict";
import { resolveMentionTargetsInText, mentionTargetWarnings } from "../server/mention-lifecycle.mjs";

// Release-room shape: the retired "Codex" member is inactive, Codex's live seat
// is "Build Worker" (identity alias codex-comm-pilot), and Dot is "Member 2".
const members = {
  "agent-old-codex": { displayName: "Codex", kind: "agent", active: false },
  "ai_dot": { displayName: "Member 2", kind: "agent", active: true },
  "ai_codex": { displayName: "Build Worker", kind: "agent", active: true },
  "ai_grok": { displayName: "Grok Bot", kind: "agent", active: true },
  "ai_jill": { displayName: "Jill 2", kind: "agent", active: true },
};
const names = { ai_dot: "Dot", ai_codex: "codex-comm-pilot", ai_grok: "Grok Bot", ai_jill: "Jill 2" };
const resolve = text => resolveMentionTargetsInText(members, names, text, "ai_grok");
const warn = text => mentionTargetWarnings(members, names, text, "ai_grok");

test("a parenthetical naming a different member never delivers to the first label", () => {
  for (const text of ["@Member 2 (codex-comm-pilot) please take this", "@Member 2 (Codex) sync", "@Dot (Build Worker) hi"]) {
    assert.deepEqual(resolve(text), [], text);
    const [warning] = warn(text);
    assert.equal(warning?.reason, "ambiguous", text);
    assert.ok(warning.candidates.length >= 2, text);
  }
  assert.deepEqual(warn("@Member 2 (codex-comm-pilot) x")[0].candidates.map(c => c.memberId).sort(), ["ai_codex", "ai_dot"]);
});

test("an explicitly @-ed qualifier is its own mention; the first label is still withheld", () => {
  assert.deepEqual(resolve("@Member 2 (@codex-comm-pilot) take this"), ["ai_codex"]);
});

test("ordinary qualifiers and unambiguous handles still deliver", () => {
  assert.deepEqual(resolve("@Member 2 (Root cover) please review"), ["ai_dot"]);
  assert.deepEqual(resolve("@Dot (urgent) look"), ["ai_dot"]);
  assert.deepEqual(resolve("@Dot (Grok Bot) look"), ["ai_dot"], "the sender named in a qualifier is not a conflict");
  assert.deepEqual(resolve("@Dot (Dot) look"), ["ai_dot"], "the same member twice is not a conflict");
  assert.deepEqual(resolve("@codex-comm-pilot take this"), ["ai_codex"]);
  assert.deepEqual(resolve("@Build Worker take this"), ["ai_codex"]);
  assert.deepEqual(resolve("@Dot (Build) look"), ["ai_dot"], "a first-word prefix is not an exact label");
  assert.deepEqual(warn("@Member 2 (Root cover) hi"), []);
});

test("a handle of only a retired member's name resolves to nobody and is flagged", () => {
  assert.deepEqual(resolve("@Codex take this"), []);
  assert.deepEqual(warn("@Codex take this").map(w => [w.handle, w.reason]), [["Codex", "not_member"]]);
});

test("qualifier on the next line is prose, not a qualifier", () => {
  assert.deepEqual(resolve("@Member 2\n(Codex) review please"), ["ai_dot"]);
});
