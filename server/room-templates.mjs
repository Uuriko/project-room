// Room templates (K012). Pure room template definitions: standup, sprint,
// incident, hiring. Each template provides a name pattern, description,
// default channels/sections, and starter prompts. instantiate() fills a
// template with values. The module is pure and dependency-free. Frozen
// outputs; malformed inputs throw RoomTemplateError. Template UI wiring
// is a later slice.
class RoomTemplateError extends Error { constructor(code, message) { super(message); this.name = "RoomTemplateError"; this.code = code; } }
const fail = (code, message) => { throw new RoomTemplateError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_room_template", message); };
const TEMPLATES = {
  standup: {
    templateId: "standup", label: "Daily standup",
    namePattern: "{{team}} standup",
    description: "Daily async standup room.",
    sections: Object.freeze(["Yesterday", "Today", "Blockers"]),
    starterPrompts: Object.freeze(["What did you ship yesterday?", "What are you working on today?", "Any blockers?"]),
  },
  sprint: {
    templateId: "sprint", label: "Sprint room",
    namePattern: "{{team}} sprint {{sprint}}",
    description: "Sprint planning and tracking room.",
    sections: Object.freeze(["Goals", "Backlog", "In progress", "Done", "Retro"]),
    starterPrompts: Object.freeze(["What are the sprint goals?", "Which items are committed?"]),
  },
  incident: {
    templateId: "incident", label: "Incident response",
    namePattern: "Incident: {{summary}}",
    description: "Incident coordination room.",
    sections: Object.freeze(["Timeline", "Mitigation", "Comms", "Postmortem"]),
    starterPrompts: Object.freeze(["What is the impact?", "Who is the incident commander?", "What is the mitigation?"]),
  },
  hiring: {
    templateId: "hiring", label: "Hiring loop",
    namePattern: "Hiring: {{role}}",
    description: "Hiring coordination room.",
    sections: Object.freeze(["Role", "Candidates", "Interviews", "Decision"]),
    starterPrompts: Object.freeze(["What is the role?", "Who is on the loop?", "What is the bar?"]),
  },
};
for (const template of Object.values(TEMPLATES)) Object.freeze(template);
Object.freeze(TEMPLATES);
// List all templates.
export function listRoomTemplates() {
  return Object.freeze(Object.values(TEMPLATES).map(t => Object.freeze({ ...t })));
}
// Get a template by id.
export function getRoomTemplate(templateId) {
  check(typeof templateId === "string" && templateId.length > 0, "templateId must be a non-empty string");
  check(TEMPLATES[templateId] !== undefined, `unknown template "${templateId}"`);
  return TEMPLATES[templateId];
}
// Instantiate a template. values fills the {{placeholders}} in namePattern.
export function instantiateRoom({ templateId, values }) {
  const template = getRoomTemplate(templateId);
  check(values !== null && typeof values === "object", "values must be an object");
  const name = template.namePattern.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    check(typeof values[key] === "string" && values[key].trim().length > 0,
      `values.${key} must be a non-empty string`);
    return values[key].trim();
  });
  return Object.freeze({ templateId, name, description: template.description,
    sections: template.sections, starterPrompts: template.starterPrompts,
    values: Object.freeze({ ...values }) });
}
export { RoomTemplateError };
