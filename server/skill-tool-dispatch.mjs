// Dispatch for the team_skill action (client/skill-tools.mjs) over
// TeamSkillsStore. The caller passes the identity it already authenticated;
// this module never reads secrets. Agents act as kind "agent", so a
// correction they relay stays a proposal until the skill author confirms it.
import { TeamSkillsStore } from "./team-skills-store.mjs";
import { validSkillToolArguments } from "../client/skill-tools.mjs";
import { SkillError } from "./team-skills.mjs";

const STATUS = { skill_not_found: 404, correction_not_found: 404, skill_forbidden: 403, skill_exists: 409, skill_limit: 409, correction_limit: 409 };

export function callSkillTool(store, roomId, actor, name, args = {}) {
  if (!validSkillToolArguments(name, args))
    throw Object.assign(new Error("Invalid team_skill arguments"), { status: 400, code: "invalid_arguments" });
  const skills = new TeamSkillsStore(store);
  try {
    switch (args.action) {
      case "list": return { roomId, skills: skills.list(roomId).map(s => ({ skillId: s.skillId, name: s.name, label: s.label, runCount: s.runCount, author: s.author.label })) };
      case "save": return { roomId, skill: skills.save(roomId, { name: args.name, instructions: args.instructions, author: actor }) };
      case "run": { const { skill, brief } = skills.run(roomId, args.skill, { by: actor }); return { roomId, skillId: skill.skillId, label: skill.label, brief: brief.text, rules: brief.rules }; }
      case "delete": return { roomId, ...skills.delete(roomId, args.skill, { by: actor }) };
      default: {
        const s = skills.correct(roomId, args.skill, { text: args.text, by: actor, source: args.source ?? null });
        const wanted = args.text.trim().toLowerCase();
        const c = s.corrections.find(x => x.text.toLowerCase() === wanted) ?? s.corrections.at(-1);
        return { roomId, skillId: s.skillId, correctionId: c.correctionId, status: c.status, next: c.status === "proposed" ? `Saved as a proposal. It does not change the skill until ${s.author.label} confirms it in Project Room, and that confirm control has not shipped yet.` : null };
      }
    }
  } catch (error) {
    if (error instanceof SkillError) throw Object.assign(error, { status: STATUS[error.code] ?? 400 });
    throw error;
  }
}
