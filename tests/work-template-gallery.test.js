// K001: work-item template gallery. Pure template tests.
import test from "node:test";
import assert from "node:assert/strict";
import { listTemplates, getTemplate, instantiate, TemplateError } from "../server/work-templates.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof TemplateError && error.code === code);

test("listTemplates returns all four", () => {
  const templates = listTemplates();
  assert.deepEqual(templates.map(t => t.templateId).sort(), ["bounty", "bug", "feature", "research"]);
  assert.ok(Object.isFrozen(templates));
});
test("instantiate fills the title pattern", () => {
  const item = instantiate({ templateId: "bug", values: { summary: "Login crashes" } });
  assert.equal(item.title, "Bug: Login crashes");
  assert.deepEqual(item.checklist.slice(0, 1), ["Reproduce the issue"]);
  assert.ok(Object.isFrozen(item));
});
test("malformed inputs are refused", () => {
  throwsCode(() => getTemplate("nope"), "invalid_template");
  throwsCode(() => instantiate({ templateId: "bug", values: {} }), "invalid_template");
  throwsCode(() => instantiate({ templateId: "bug", values: { summary: "  " } }), "invalid_template");
});
