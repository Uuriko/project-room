import test from "node:test";
import assert from "node:assert/strict";
import { buildRegistrationItems, summariseItems } from "../scripts/verify-pr-registration.mjs";

// Synthetic-snapshot tests for the diff-keyed registration checklist that
// `npm run verify:pr` runs as its last step. Every rule that has bounced a
// PR on a hosted round gets a both-ways case here: missing registration
// fails, present registration passes.

function snapshot(overrides = {}) {
  return {
    changed: [],
    addedLines: new Map(),
    fileContents: new Map(),
    untestedServerModules: new Set(),
    packagedClosures: new Map([["server.mjs", new Set(["server.mjs"])]]),
    runtimeAllowed: new Set(),
    publicAssets: [],
    buildAssetsSource: "",
    importedByPublicAssets: new Set(),
    writerFenceSource: "",
    purgeRegistrySource: "",
    packageJsonSource: "",
    routeAuthTableSource: "",
    inviteOnlyChecklistSource: "",
    inviteProbesSource: "",
    openOperationsCurrent: [],
    openOperationsBase: [],
    ...overrides,
  };
}

const failsFor = (items, rule) =>
  summariseItems(items).failures.filter(i => i.rule.includes(rule));

test("planted omission: a new server module with no test reference fails", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: "server/planted.mjs", status: "A" }],
    untestedServerModules: new Set(["planted.mjs"]),
  }));
  assert.equal(failsFor(items, "direct import").length, 1);
});

test("a new server module with a test reference passes the import rule", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: "server/tested.mjs", status: "A" }],
  }));
  assert.equal(failsFor(items, "direct import").length, 0);
  assert.ok(items.some(i => i.rule.includes("direct import") && i.status === "pass"));
});

test("a module in the packaged closure but not allowlisted fails runtime-package", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: "server/wired.mjs", status: "A" }],
    packagedClosures: new Map([["server.mjs", new Set(["server.mjs", "server/wired.mjs"])]]),
  }));
  assert.equal(failsFor(items, "runtime-package").length, 1);
});

test("an allowlisted module in the packaged closure passes runtime-package", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: "server/wired.mjs", status: "A" }],
    packagedClosures: new Map([["server.mjs", new Set(["server.mjs", "server/wired.mjs"])]]),
    runtimeAllowed: new Set(["server/wired.mjs"]),
  }));
  assert.equal(failsFor(items, "runtime-package").length, 0);
});

test("a new open route missing its auth-table and probe registrations fails all three", () => {
  const items = buildRegistrationItems(snapshot({
    openOperationsCurrent: [{ method: "GET", path: "/api/widgets", open: true }],
  }));
  assert.equal(failsFor(items, "ROUTE-AUTH-TABLE").length, 1);
  assert.equal(failsFor(items, "INVITE-ONLY-CHECKLIST").length, 1);
  assert.equal(failsFor(items, "PROBES").length, 1);
});

test("a new open route with all registrations passes, and a pre-existing open route is not re-checked", () => {
  const items = buildRegistrationItems(snapshot({
    routeAuthTableSource: "GET /api/widgets is open",
    inviteOnlyChecklistSource: "1. /api/widgets",
    inviteProbesSource: '{ "GET /api/widgets": [{}, 200] }',
    openOperationsCurrent: [
      { method: "GET", path: "/api/widgets", open: true },
      { method: "GET", path: "/api/legacy", open: true },
    ],
    openOperationsBase: [{ method: "GET", path: "/api/legacy", open: true }],
  }));
  assert.equal(summariseItems(items).failures.length, 0);
  assert.equal(items.filter(i => i.status === "pass" && i.rule.includes("open route")).length, 3);
});

test("a new table missing from the writer-fence census and purge registry fails both", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: "server/store.mjs", status: "M" }],
    addedLines: new Map([["server/store.mjs", "CREATE TABLE widget_journal (id TEXT);\n"]]),
  }));
  assert.equal(failsFor(items, "writer-fence").length, 1);
  assert.equal(failsFor(items, "purge/retention").length, 1);
});

test("a new table registered in both censuses passes", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: "server/store.mjs", status: "M" }],
    addedLines: new Map([["server/store.mjs", "CREATE TABLE widget_journal (id TEXT);\n"]]),
    writerFenceSource: 'const tables = ["widget_journal"];',
    purgeRegistrySource: 'export const PURGE_TABLES = [{ table: "widget_journal" }];',
  }));
  assert.equal(summariseItems(items).failures.length, 0);
});

test("a browser check script that is not in package.json fails; a listed one passes", () => {
  const file = "scripts/widget-browser-check.mjs";
  const missing = buildRegistrationItems(snapshot({
    changed: [{ path: file, status: "A" }],
    fileContents: new Map([[file, "import { chromium } from 'playwright';"]]),
    packageJsonSource: "{}",
  }));
  assert.equal(failsFor(missing, "browser-check").length, 1);
  const listed = buildRegistrationItems(snapshot({
    changed: [{ path: file, status: "A" }],
    fileContents: new Map([[file, "import { chromium } from 'playwright';"]]),
    packageJsonSource: '"test:browser": "node --test scripts/widget-browser-check.mjs"',
  }));
  assert.equal(failsFor(listed, "browser-check").length, 0);
});

test("a public asset missing from the Cloudflare asset list fails; a complete one passes", () => {
  const missing = buildRegistrationItems(snapshot({
    changed: [{ path: "src/widget.js", status: "A" }],
    publicAssets: ["src/widget.js"],
    buildAssetsSource: "export const assetPaths = [];",
    runtimeAllowed: new Set(["src/widget.js"]),
  }));
  assert.equal(failsFor(missing, "public-asset").length, 1);
  const complete = buildRegistrationItems(snapshot({
    changed: [{ path: "src/widget.js", status: "A" }],
    publicAssets: ["src/widget.js"],
    buildAssetsSource: "export const assetPaths = ['src/widget.js'];",
    runtimeAllowed: new Set(["src/widget.js"]),
  }));
  assert.equal(failsFor(complete, "public-asset").length, 0);
});

test("a tag-pinned workflow action in added lines fails", () => {
  const items = buildRegistrationItems(snapshot({
    changed: [{ path: ".github/workflows/widget.yml", status: "A" }],
    addedLines: new Map([[".github/workflows/widget.yml", "      - uses: actions/checkout@v4\n"]]),
  }));
  assert.equal(failsFor(items, "workflow action pins").length, 1);
});
