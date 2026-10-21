import test from "node:test";
import assert from "node:assert/strict";
import { createSkillRegistry, SkillError, MAX_ACTIVE_CORRECTIONS, BRIEF_TOKEN_CAP } from "../server/team-skills.mjs";

const douglas = { kind: "human", id: "douglas", label: "Douglas" };
const becky = { kind: "human", id: "becky", label: "Becky" };
const bot = { kind: "agent", id: "codex", label: "Codex" };
const code = (fn, c) => assert.throws(fn, e => e instanceof SkillError && e.code === c);
const reg = () => { let n = 0; return createSkillRegistry({ clock: () => 0, id: () => `id-${++n}` }); };

test("skill credits its author and counts runs by anyone", () => {
  const r = reg();
  const s = r.save({ name: "GTM skill", instructions: "Read the planning call, build the workback with owners and dates.", author: douglas });
  assert.equal(s.label, "Douglas's GTM skill, used 0 times");
  r.run(s.skillId, { by: becky });
  r.run(s.skillId, { by: bot });
  const after = r.get(s.skillId);
  assert.equal(after.runCount, 2);
  assert.equal(after.lastRunBy.id, "codex");
  assert.equal(after.label, "Douglas's GTM skill, used 2 times");
  assert.equal(r.find("gtm skill").skillId, s.skillId);
  code(() => r.save({ name: "GTM  Skill", instructions: "x", author: becky }), "skill_exists");
});

test("list sorts most used first", () => {
  const r = reg();
  r.save({ name: "A", instructions: "a", author: douglas });
  const b = r.save({ name: "B", instructions: "b", author: becky });
  r.run(b.skillId, { by: douglas });
  assert.deepEqual(r.list().map(s => s.name), ["B", "A"]);
});

test("corrections are scoped to the skill and load only in its brief", () => {
  const r = reg();
  const s = r.save({ name: "Team page", instructions: "Add people to the team page.", author: douglas });
  const other = r.save({ name: "Release notes", instructions: "Summarize merged PRs.", author: douglas });
  r.correct(s.skillId, { text: "Keep every bio under 50 words", by: douglas });
  assert.deepEqual([...r.run(s.skillId, { by: becky }).rules], ["Keep every bio under 50 words"]);
  assert.deepEqual([...r.brief(other.skillId).rules], []);
});

test("non-author corrections start proposed; repeat or author confirm activates", () => {
  const r = reg();
  const s = r.save({ name: "Team page", instructions: "Add people.", author: douglas });
  let v = r.correct(s.skillId, { text: "Use first names only", by: becky });
  assert.equal(v.corrections[0].status, "proposed");
  assert.deepEqual([...r.brief(s.skillId).rules], []);
  v = r.correct(s.skillId, { text: "use first names only.", by: { ...bot, kind: "human", id: "kate" } });
  assert.equal(v.corrections[0].status, "active");
  const p = r.correct(s.skillId, { text: "Link every headshot to the CDN", by: becky }).corrections[1];
  code(() => r.confirm(s.skillId, p.correctionId, { by: becky }), "skill_forbidden");
  assert.equal(r.confirm(s.skillId, p.correctionId, { by: douglas }).corrections[1].status, "active");
});

test("vague and over-cap corrections are refused, agent relays stay proposed; retire frees a slot", () => {
  const r = reg();
  const s = r.save({ name: "S", instructions: "Do it.", author: douglas });
  code(() => r.correct(s.skillId, { text: "be better", by: douglas }), "correction_vague");
  const relayed = r.correct(s.skillId, { text: "Always add a summary line", by: bot });
  assert.equal(relayed.corrections.at(-1).status, "proposed");
  r.correct(s.skillId, { text: "Always add a summary line", by: bot });
  assert.equal(r.get(s.skillId).corrections.at(-1).status, "proposed");
  r.retire(s.skillId, relayed.corrections.at(-1).correctionId, { by: douglas });
  for (let i = 0; i < MAX_ACTIVE_CORRECTIONS; i++) r.correct(s.skillId, { text: `Rule number ${i} applies here`, by: douglas });
  code(() => r.correct(s.skillId, { text: "One rule too many here", by: douglas }), "correction_limit");
  const first = r.get(s.skillId).corrections.find(c => c.status === "active");
  r.retire(s.skillId, first.correctionId, { by: douglas });
  r.correct(s.skillId, { text: "One rule too many here", by: douglas });
  assert.equal(r.brief(s.skillId).rules.length, MAX_ACTIVE_CORRECTIONS);
});

test("brief stays under the token cap", () => {
  const r = reg();
  const s = r.save({ name: "Long", instructions: "word ".repeat(800).trim(), author: douglas });
  assert.ok(r.brief(s.skillId).tokens <= BRIEF_TOKEN_CAP);
});

test("snapshot round-trips through initial", () => {
  const r = reg();
  const s = r.save({ name: "S", instructions: "Do it.", author: douglas });
  r.run(s.skillId, { by: becky });
  r.correct(s.skillId, { text: "Always cite the source doc", by: douglas });
  const r2 = createSkillRegistry({ initial: r.snapshot() });
  assert.equal(r2.get(s.skillId).runCount, 1);
  assert.deepEqual([...r2.brief(s.skillId).rules], ["Always cite the source doc"]);
});
