// Work-item template gallery (K001). Pure template definitions for common
// work-item types: bug, feature, research, bounty. Each template provides
// a title pattern, default fields, checklist items, and required roles.
// instantiate() fills a template with values. The module is pure and
// dependency-free. Frozen outputs; malformed inputs throw TemplateError.
// Gallery UI wiring is a later slice.
class TemplateError extends Error { constructor(code, message) { super(message); this.name = "TemplateError"; this.code = code; } }
const fail = (code, message) => { throw new TemplateError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_template", message); };
const TEMPLATES = {
  bug: {
    templateId: "bug", label: "Bug report",
    titlePattern: "Bug: {{summary}}",
    fields: Object.freeze({ priority: "high", labels: Object.freeze(["bug"]) }),
    checklist: Object.freeze(["Reproduce the issue", "Identify root cause", "Fix and verify", "Add regression test"]),
    requiredRoles: Object.freeze(["accountable", "verifier"]),
  },
  feature: {
    templateId: "feature", label: "Feature request",
    titlePattern: "Feature: {{summary}}",
    fields: Object.freeze({ priority: "medium", labels: Object.freeze(["enhancement"]) }),
    checklist: Object.freeze(["Write spec", "Implement", "Review", "Document"]),
    requiredRoles: Object.freeze(["accountable", "verifier", "decider"]),
  },
  research: {
    templateId: "research", label: "Research spike",
    titlePattern: "Research: {{summary}}",
    fields: Object.freeze({ priority: "low", labels: Object.freeze(["research"]) }),
    checklist: Object.freeze(["Define questions", "Gather sources", "Synthesize findings", "Recommend next step"]),
    requiredRoles: Object.freeze(["accountable"]),
  },
  bounty: {
    templateId: "bounty", label: "Bounty task",
    titlePattern: "Bounty: {{summary}}",
    fields: Object.freeze({ priority: "medium", labels: Object.freeze(["bounty"]) }),
    checklist: Object.freeze(["Post bounty terms", "Accept submission", "Verify work", "Release escrow"]),
    requiredRoles: Object.freeze(["accountable", "verifier", "decider"]),
  },
};
for (const template of Object.values(TEMPLATES)) Object.freeze(template);
Object.freeze(TEMPLATES);
// List all templates.
export function listTemplates() {
  return Object.freeze(Object.values(TEMPLATES).map(t => Object.freeze({ ...t })));
}
// Get a template by id.
export function getTemplate(templateId) {
  check(typeof templateId === "string" && templateId.length > 0, "templateId must be a non-empty string");
  check(TEMPLATES[templateId] !== undefined, `unknown template "${templateId}"`);
  return TEMPLATES[templateId];
}
// Instantiate a template with values. values.summary is required.
export function instantiate({ templateId, values }) {
  const template = getTemplate(templateId);
  check(values !== null && typeof values === "object", "values must be an object");
  check(typeof values.summary === "string" && values.summary.trim().length > 0,
    "values.summary must be a non-empty string");
  const title = template.titlePattern.replace("{{summary}}", values.summary.trim());
  return Object.freeze({ templateId, title,
    fields: template.fields,
    checklist: template.checklist,
    requiredRoles: template.requiredRoles,
    values: Object.freeze({ ...values }) });
}
export { TemplateError };
