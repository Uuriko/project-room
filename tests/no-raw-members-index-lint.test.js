import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Linter } from "eslint";
import membersRules from "../scripts/eslint-rules/no-raw-members-index.mjs";
import { RAW_MEMBERS_INDEX_ENFORCED } from "../eslint.config.mjs";

const config = [{ files: ["**/*.mjs"], languageOptions: { ecmaVersion: "latest", sourceType: "module" }, plugins: { room: membersRules }, rules: { "room/no-raw-members-index": "error" } }];
const lint = (code, filename = "server/x.mjs") => new Linter().verify(code, config, { filename }).filter(m => m.ruleId === "room/no-raw-members-index").map(m => m.line);

test("flags raw indexing into a members map", () => {
  assert.deepEqual(lint("const m = state.members[id];"), [1]);
  assert.deepEqual(lint("const m = room.state.members[memberId];"), [1]);
  assert.deepEqual(lint("const p = authority.members[id]?.permissions ?? [];"), [1]);
  assert.deepEqual(lint("function f(members, id) { return members[id]; }"), [1]);
  assert.deepEqual(lint('const m = state["members"][id];'), [1]);
  assert.deepEqual(lint("a(state.members[x]);\nb(state.members[y]);"), [1, 2]);
});

test("does not flag the canonical helper, guards, or other maps", () => {
  assert.deepEqual(lint("const m = ownMember(state.members, id);"), []);
  assert.deepEqual(lint("const ok = Object.hasOwn(state.members, id);"), []);
  assert.deepEqual(lint("const all = state.members;"), []);
  assert.deepEqual(lint("const w = state.workItems[id];"), []);
  assert.deepEqual(lint("const m = members.get(id);"), []);
  assert.deepEqual(lint("const n = state.membersCount;"), []);
});

test("every enforced file exists, uses ownMember, and lints clean", () => {
  assert.ok(RAW_MEMBERS_INDEX_ENFORCED.length > 0);
  for (const file of RAW_MEMBERS_INDEX_ENFORCED) {
    assert.ok(existsSync(file), `${file} is in RAW_MEMBERS_INDEX_ENFORCED but does not exist`);
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("ownMember("), `${file} is enforced but never resolves a member through ownMember — stale entry`);
    assert.deepEqual(lint(source, file), [], `${file} is enforced but still contains raw members[ indexing`);
  }
});
