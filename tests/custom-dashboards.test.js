// G010: custom analytics dashboards. Pure view tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createDashboards, DashboardError } from "../server/dashboards.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DashboardError && error.code === code);

test("create/list/resolve/remove lifecycle", () => {
  const dash = createDashboards();
  const view = dash.create({ name: "Weekly", ownerId: "ada",
    metrics: ["messages", "activeUsers"], roomIds: ["r1"], days: 7 });
  assert.ok(view.viewId.startsWith("view-"));
  assert.ok(Object.isFrozen(view));
  assert.equal(dash.list("ada").length, 1);
  const spec = dash.resolve(view.viewId);
  assert.deepEqual(spec.metrics, ["messages", "activeUsers"]);
  assert.equal(spec.days, 7);
  dash.remove("ada", { viewId: view.viewId });
  assert.equal(dash.list("ada").length, 0);
});
test("non-owner delete is refused", () => {
  const dash = createDashboards();
  const view = dash.create({ name: "V", ownerId: "ada", metrics: ["messages"] });
  throwsCode(() => dash.remove("bob", { viewId: view.viewId }), "invalid_dashboard");
});
test("malformed inputs are refused", () => {
  const dash = createDashboards();
  throwsCode(() => dash.create({ name: "V", ownerId: "a", metrics: ["nope"] }), "invalid_dashboard");
  throwsCode(() => dash.resolve("ghost"), "invalid_dashboard");
});
