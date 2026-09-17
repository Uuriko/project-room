// O004: API reference generator. Pure generator tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePaths, pathsToMarkdown, ApiError } from "../server/api-ref-gen.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ApiError && error.code === code);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parses real openapi.yaml", () => {
  const yaml = readFileSync(join(root, "docs", "openapi.yaml"), "utf8");
  const paths = parsePaths({ yaml });
  assert.ok(paths.length > 10, `expected many paths, got ${paths.length}`);
  assert.ok(paths.every(p => p.path.startsWith("/")));
  assert.ok(Object.isFrozen(paths));
  const md = pathsToMarkdown({ paths, title: "Project Room API" });
  assert.ok(md.includes("# Project Room API"));
  assert.ok(md.includes("## `/api/"));
});
test("malformed inputs are refused", () => {
  throwsCode(() => parsePaths({ yaml: "" }), "invalid_api");
  throwsCode(() => pathsToMarkdown({ paths: "nope" }), "invalid_api");
});
