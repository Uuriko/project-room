// The iOS keyboard covers the composer unless the viewport asks the
// browser to resize the layout. Unsupported browsers ignore the extra
// descriptor, so desktop layout stays the same.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const RESIZE = "interactive-widget=resizes-content";

for (const file of ["index.html", "join.html"]) {
  test(`${file} viewport asks the keyboard to resize the layout`, () => {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const meta = html.match(/<meta name="viewport" content="([^"]+)">/);
    assert.ok(meta, `${file} has a viewport meta`);
    assert.match(meta[1], /width=device-width/);
    assert.match(meta[1], /initial-scale=1\b/);
    assert.ok(meta[1].split(",").map(part => part.trim()).includes(RESIZE),
      `${file} must include ${RESIZE}`);
  });
}
