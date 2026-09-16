// A017: reply templates. Pure template tests.
import test from "node:test";
import assert from "node:assert/strict";
import { placeholdersOf, renderTemplate, createTemplates, TemplateError } from "../server/reply-templates.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof TemplateError && error.code === code);

test("placeholdersOf extracts names, renderTemplate substitutes", () => {
  assert.deepEqual(placeholdersOf("Hi {{name}}, your {{item}} is ready."), ["name", "item"]);
  assert.equal(renderTemplate("Hi {{name}}!", { name: "Ada" }), "Hi Ada!");
  throwsCode(() => renderTemplate("Hi {{name}}!", {}), "missing_variable");
});
test("create/list/render/remove lifecycle", () => {
  const templates = createTemplates();
  const created = templates.create({ templateId: "t1", name: "Welcome",
    body: "Welcome {{name}} to {{room}}.", category: "greeting" });
  assert.deepEqual(created.placeholders, ["name", "room"]);
  assert.ok(Object.isFrozen(created));
  templates.create({ templateId: "t2", name: "Bye", body: "Bye {{name}}." });
  assert.equal(templates.list().length, 2);
  assert.equal(templates.list({ category: "greeting" }).length, 1);
  assert.equal(templates.render("t1", { name: "Ada", room: "commons" }), "Welcome Ada to commons.");
  templates.remove("t1");
  assert.equal(templates.size(), 1);
});
test("malformed inputs are refused", () => {
  const templates = createTemplates();
  throwsCode(() => templates.create({ templateId: "t", name: "", body: "x" }), "invalid_template");
  throwsCode(() => templates.get("ghost"), "invalid_template");
  throwsCode(() => templates.remove("ghost"), "invalid_template");
});
