// Reply templates (A017). A pure template manager: create named templates
// with {{variable}} placeholders, list them, and render by substituting
// variables. Missing variables throw; extra variables are ignored. All
// state is caller-owned (a Map); the module is pure and dependency-free.
// Frozen outputs; malformed inputs throw TemplateError. Template UI
// wiring is a later slice.
class TemplateError extends Error { constructor(code, message) { super(message); this.name = "TemplateError"; this.code = code; } }
const fail = (code, message) => { throw new TemplateError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_template", message); };
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
// Extract placeholder names from a body.
export function placeholdersOf(body) {
  check(typeof body === "string", "body must be a string");
  const names = new Set();
  for (const match of body.matchAll(PLACEHOLDER)) names.add(match[1]);
  return Object.freeze([...names]);
}
// Render a body by substituting variables. Throws on missing variables.
export function renderTemplate(body, variables) {
  check(typeof body === "string" && body.length > 0, "body must be a non-empty string");
  check(variables !== null && typeof variables === "object" && !Array.isArray(variables),
    "variables must be an object");
  const missing = placeholdersOf(body).filter(name => !(name in variables));
  if (missing.length > 0)
    fail("missing_variable", `missing variables: ${missing.join(", ")}`);
  const rendered = body.replace(PLACEHOLDER, (_, name) => String(variables[name]));
  return rendered;
}
// Create a template store. store is a caller-owned Map (templateId -> template).
export function createTemplates({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const templates = store ?? new Map();
  // Create a template.
  const create = ({ templateId, name, body, category }) => {
    check(typeof templateId === "string" && templateId.length > 0, "templateId must be a non-empty string");
    check(typeof name === "string" && name.length > 0 && name.length <= 200, "name must be 1-200 chars");
    check(typeof body === "string" && body.length > 0 && body.length <= 10000, "body must be 1-10000 chars");
    check(category === undefined || (typeof category === "string" && category.length <= 100),
      "category must be ≤100 chars if given");
    check(!templates.has(templateId), `template "${templateId}" already exists`);
    const template = Object.freeze({ templateId, name, body, category: category ?? null,
      placeholders: placeholdersOf(body) });
    templates.set(templateId, template);
    return template;
  };
  const get = templateId => {
    check(typeof templateId === "string" && templateId.length > 0, "templateId must be a non-empty string");
    check(templates.has(templateId), `unknown template "${templateId}"`);
    return templates.get(templateId);
  };
  // List templates, optionally filtered by category.
  const list = ({ category } = {}) => {
    const all = [...templates.values()];
    const filtered = category === undefined ? all : all.filter(t => t.category === category);
    return Object.freeze(filtered.map(t => Object.freeze({ ...t })));
  };
  // Render a template by id.
  const render = (templateId, variables) => renderTemplate(get(templateId).body, variables);
  const remove = templateId => {
    check(typeof templateId === "string" && templateId.length > 0, "templateId must be a non-empty string");
    check(templates.delete(templateId), `unknown template "${templateId}"`);
  };
  return Object.freeze({ create, get, list, render, remove, size: () => templates.size });
}
export { TemplateError };
