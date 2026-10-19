// The room view must expose exactly one level-1 heading at every width.
// On desktop it is the sidebar's .sidebar-head (role=heading, level 1);
// at <=940px the sidebar is display:none, which used to take the page's
// only level-1 heading out of the accessibility tree with it (axe
// page-has-heading-one at 390px — ATLAS-CLIENT W-11). #mobile-room-name
// is the room name the topbar shows at exactly those widths (display:none
// above 940px, display:block at/below it), so it carries the level-1
// heading semantics there instead. Semantics only: no visual change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("the mobile room name carries the level-1 heading semantics", () => {
  assert.match(html, /<span id="mobile-room-name" role="heading" aria-level="1"><\/span>/,
    "#mobile-room-name must be a level-1 heading for narrow widths");
});

test("the desktop sidebar head keeps its level-1 heading semantics", () => {
  assert.match(html, /<div class="sidebar-head" role="heading" aria-level="1">/,
    ".sidebar-head must stay the level-1 heading where the sidebar shows");
});

test("the two headings are never in the tree at the same width", () => {
  // Base rule hides the mobile room name; the <=940px block shows it in
  // the same breakpoint range where #room-sidebar becomes display:none.
  assert.match(css, /#mobile-room-name \{ display: none; \}/,
    "base rule keeps #mobile-room-name out of the desktop tree");
  assert.match(css, /@media \(max-width: 940px\) \{\n  #mobile-room-name \{ display: block;/,
    "the <=940px block is what puts #mobile-room-name in the tree");
  assert.match(css, /#room-sidebar \{ display: none;/,
    "the sidebar (and its heading) leaves the tree at narrow widths");
});
