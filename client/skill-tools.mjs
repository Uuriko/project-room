// Team skill actions for the hosted MCP surface, reachable through
// room_search_actions / room_run_action once registered in the hosted tool
// list. Pure definitions plus argument validation; dispatch lives in
// server/skill-tool-dispatch.mjs.
const text = (max, description) => ({ type: "string", minLength: 1, maxLength: max, description });
const skillRef = text(80, "Skill name or id.");
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, readOnly) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false }
});

export const skillTools = [
  tool("skill_list", "List this room's team skills, most used first. Each shows its author and run count, for example \"Douglas's GTM skill, used 23 times\". Read only.", schema(), true),
  tool("skill_save", "Save a repeatable workflow as a team skill credited to you. name is unique in the room; instructions are plain language. Anyone in the room can run it.", schema({ name: text(80, "Skill name."), instructions: text(4000, "Plain-language steps.") }, ["name", "instructions"]), false),
  tool("skill_run", "Run a team skill. Returns the skill brief (instructions plus its active corrections) to follow, and counts the run.", schema({ skill: skillRef }, ["skill"]), false),
  tool("skill_correct", "Relay a person's correction to a team skill, for example \"Keep every bio under 50 words\". It is saved to that skill only and stays a proposal until the skill author confirms it. Be specific; vague corrections are refused.", schema({ skill: skillRef, text: text(280, "The correction, as the person said it."), source: text(200, "Where it was said, such as a message id.") }, ["skill", "text"]), false),
];

const BY_NAME = new Map(skillTools.map(entry => [entry.name, entry]));
export const isSkillTool = name => typeof name === "string" && BY_NAME.has(name);
export const skillToolIsWrite = name => isSkillTool(name) && !BY_NAME.get(name).annotations.readOnlyHint;

export function validSkillToolArguments(name, args) {
  const entry = BY_NAME.get(name);
  if (!entry || !args || typeof args !== "object" || Array.isArray(args)) return false;
  const { properties, required } = entry.inputSchema;
  if (!required.every(key => typeof args[key] === "string" && args[key].trim())) return false;
  return Object.entries(args).every(([key, value]) => {
    const spec = properties[key];
    return spec && typeof value === "string" && value.trim().length >= 1 && value.length <= spec.maxLength;
  });
}
