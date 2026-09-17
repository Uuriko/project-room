// W013: wiki export as markdown bundle. Pure exporter tests.
import test from "node:test";
import assert from "node:assert/strict";
import { exportWiki, ExportError } from "../server/wiki-export.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ExportError && error.code === code);

test("exports pages with index", () => {
  const bundle = exportWiki({ title: "My Wiki", pages: [
    { pageId: "p1", title: "Getting Started", content: "Hello world." },
    { pageId: "p2", title: "FAQ", content: "Questions." },
  ]});
  assert.equal(bundle.pageCount, 2);
  assert.ok(bundle.index.includes("# My Wiki"));
  assert.ok(bundle.index.includes("[Getting Started](p1.md)"));
  assert.equal(bundle.pages[0].filename, "p1.md");
  assert.ok(bundle.pages[0].content.includes("# Getting Started"));
  assert.ok(Object.isFrozen(bundle));
});
test("malformed inputs are refused", () => {
  throwsCode(() => exportWiki({ pages: "nope" }), "invalid_export");
  throwsCode(() => exportWiki({ pages: [{ pageId: "", title: "x", content: "y" }] }), "invalid_export");
});
