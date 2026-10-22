// Front door: /docs/agents/* pages must not scroll sideways on a 390px phone.
// Long inline commands (curl lines in <li><code>) had no break points and
// pushed /docs/agents/paste to scrollWidth 585 at 390. Inline code now wraps
// anywhere; <pre> blocks keep their own keyboard-reachable scroll.
import test from "node:test";
import assert from "node:assert/strict";
import { agentPages, PASTE_PAGE } from "../scripts/build-agent-docs.mjs";

test("agent docs pages let inline code wrap so 390px phones do not scroll sideways", () => {
  const pages = agentPages();
  const paste = pages.get(PASTE_PAGE.htmlFile);
  assert.ok(paste, "paste page is generated");
  for (const [file, html] of pages) {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
    assert.match(style, /:not\(pre\)>code\{overflow-wrap:anywhere\}/, `${file} wraps inline code`);
    assert.match(style, /pre\{[^}]*overflow:auto;/, `${file} keeps pre blocks scrollable`);
  }
});
