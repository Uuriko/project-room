// Team skill action for the hosted MCP surface: one tool, team_skill, with
// action list | save | run | correct, reachable through room_search_actions
// and room_run_action. One tool instead of four keeps the full catalog
// inside its budget. Pure definition plus argument validation; dispatch
// lives in server/skill-tool-dispatch.mjs.
const text = (max, description) => ({ type: "string", minLength: 1, maxLength: max, description });

export const SKILL_ACTIONS = Object.freeze(["list", "save", "run", "correct"]);
const REQUIRED = Object.freeze({ list: [], save: ["name", "instructions"], run: ["skill"], correct: ["skill", "text"] });

export const skillTools = [{
  name: "team_skill",
  description: "Team skills: named, repeatable workflows saved in this room, credited to their author with a run count (\"Douglas's GTM skill, used 23 times\"). action list shows them most used first. action save { name, instructions } saves one credited to you. action run { skill } returns the brief to follow (instructions plus active corrections) and counts the run. action correct { skill, text } relays a person's correction, saved to that skill only; it stays a proposal until the skill author confirms it. skill is a name or id.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...SKILL_ACTIONS] },
      skill: text(80, "Skill name or id (run, correct)."),
      name: text(80, "New skill name (save)."),
      instructions: text(4000, "Plain-language steps (save)."),
      text: text(280, "The correction, as the person said it (correct)."),
      source: text(200, "Where the correction was said, such as a message id (correct).")
    },
    required: ["action"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}];

export const isSkillTool = name => name === "team_skill";
// list is a read; everything else writes.
export const skillToolIsWrite = (name, args = {}) => isSkillTool(name) && args?.action !== "list";

export function validSkillToolArguments(name, args) {
  if (!isSkillTool(name) || !args || typeof args !== "object" || Array.isArray(args)) return false;
  const { properties } = skillTools[0].inputSchema;
  if (!SKILL_ACTIONS.includes(args.action)) return false;
  for (const [key, value] of Object.entries(args)) {
    if (key === "action") continue;
    const spec = properties[key];
    if (!spec || typeof value !== "string" || !value.trim() || value.length > spec.maxLength) return false;
  }
  return REQUIRED[args.action].every(key => typeof args[key] === "string");
}
