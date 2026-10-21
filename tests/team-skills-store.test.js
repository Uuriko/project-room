import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamSkillsStore } from "../server/team-skills-store.mjs";
import { callSkillTool } from "../server/skill-tool-dispatch.mjs";
import { skillTools, validSkillToolArguments, skillToolIsWrite } from "../client/skill-tools.mjs";

const douglas = { kind: "human", id: "douglas", label: "Douglas" };
const codex = { kind: "agent", id: "codex", label: "Codex" };
function open(file, init = true) { const s = new RoomStore(file); if (init) s.initialize(initialRoom("commons")); return s; }
function temp(t) { const dir = mkdtempSync(join(tmpdir(), "team-skills-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, "room.sqlite"); }

test("skills persist across store instances and stay room scoped", t => {
  const file = temp(t);
  {
    let db = open(file);
    const s = new TeamSkillsStore(db).save("room-a", { name: "GTM skill", instructions: "Build the workback.", author: douglas });
    new TeamSkillsStore(db).run("room-a", "gtm skill", { by: codex });
    new TeamSkillsStore(db).correct("room-a", s.skillId, { text: "Owners and dates on every row", by: douglas });
    db.close();
    db = open(file, false);
    const store = new TeamSkillsStore(db);
    const back = store.read("room-a", "GTM skill");
    assert.equal(back.runCount, 1);
    assert.equal(back.label, "Douglas's GTM skill, used 1 time");
    assert.equal(back.corrections[0].status, "active");
    assert.deepEqual(store.list("room-b"), []);
    assert.throws(() => store.read("room-b", "GTM skill"), { code: "skill_not_found" });
    db.close();
  }
});

test("a failed operation rolls back", t => {
  const db = open(temp(t));
  const store = new TeamSkillsStore(db);
  store.save("r", { name: "S", instructions: "x", author: douglas });
  assert.throws(() => store.save("r", { name: "s", instructions: "y", author: douglas }), { code: "skill_exists" });
  assert.equal(store.list("r").length, 1);
});

test("team_skill action: save, run, correct and list through the dispatcher", t => {
  const db = open(temp(t));
  const call = (actor, args) => callSkillTool(db, "r", actor, "team_skill", args);
  const saved = call(douglas, { action: "save", name: "Team page", instructions: "Add people to the team page." });
  assert.equal(saved.skill.author.id, "douglas");
  const relay = call(codex, { action: "correct", skill: "Team page", text: "Keep every bio under 50 words" });
  assert.equal(relay.status, "proposed");
  assert.match(relay.next, /Douglas/);
  const run = call(codex, { action: "run", skill: "team page" });
  assert.deepEqual(run.rules, []);
  assert.match(run.brief, /Add people/);
  new TeamSkillsStore(db).confirm("r", "Team page", relay.correctionId, { by: douglas });
  assert.deepEqual(call(codex, { action: "run", skill: "Team page" }).rules, ["Keep every bio under 50 words"]);
  assert.equal(call(codex, { action: "list" }).skills[0].label, "Douglas's Team page, used 2 times");
  assert.throws(() => call(codex, { action: "run", skill: "nope" }), { status: 404 });
  assert.throws(() => call(codex, { action: "run" }), { status: 400 });
});

test("team_skill definition validates arguments and marks writes", () => {
  assert.deepEqual(skillTools.map(t => t.name), ["team_skill"]);
  assert.equal(validSkillToolArguments("team_skill", { action: "run", skill: "x", extra: "y" }), false);
  assert.equal(validSkillToolArguments("team_skill", { action: "correct", skill: "x", text: "a".repeat(281) }), false);
  assert.equal(validSkillToolArguments("team_skill", { action: "save", name: "n", instructions: "i" }), true);
  assert.equal(validSkillToolArguments("team_skill", { action: "delete" }), false);
  assert.equal(skillToolIsWrite("team_skill", { action: "list" }), false);
  assert.equal(skillToolIsWrite("team_skill", { action: "save" }), true);
});

test("room purge removes the room's skills and nothing else", async t => {
  const { PURGE_TABLES } = await import("../server/purge-registry.mjs");
  const { countPurge } = await import("../server/operator-purge.mjs");
  const entry = PURGE_TABLES.find(e => e.table === "room_team_skills");
  assert.ok(entry, "purge registry covers room_team_skills");
  assert.equal(entry.action, "delete");
  assert.deepEqual(entry.match.room, ["room_id"]);
  const db = open(temp(t));
  const rowsFor = roomId => countPurge(db, [{ kind: "room", id: roomId }]).find(r => r.table === "room_team_skills").rows;
  assert.equal(rowsFor("room-a"), 0, "absent table counts as zero");
  const skills = new TeamSkillsStore(db);
  skills.save("room-a", { name: "A1", instructions: "x", author: douglas });
  skills.save("room-a", { name: "A2", instructions: "x", author: douglas });
  skills.save("room-b", { name: "B1", instructions: "x", author: douglas });
  assert.equal(rowsFor("room-a"), 2);
  assert.equal(rowsFor("room-b"), 1);
});

test("room_search_actions finds team_skill with its exact schema", async () => {
  const { searchActions } = await import("../server/mcp-action-search.mjs");
  const found = searchActions("run team skill");
  assert.equal(found.matches[0].name, "team_skill");
  assert.deepEqual(found.matches[0].inputSchema.properties.action.enum, ["list", "save", "run", "correct"]);
});
