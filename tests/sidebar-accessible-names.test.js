import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { memberRowName } from "../src/conversation.js";

// NEXT-5: every control in the signed-in sidebar needs an accessible name.
// The browser suite checks the live accessibility tree; this is the cheap
// inventory scan over the shipped markup, in the spirit of the ui-inventory
// pass that found the unnamed controls in the first place.
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const sidebar = html.match(/<aside id="room-sidebar"[\s\S]*?<\/aside>/)?.[0] ?? "";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const textOf = markup => markup
  // Decoration is hidden from assistive tech, so it cannot name a control.
  .replace(/<span\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity) => ENTITIES[entity])
  .replace(/\s+/g, " ")
  .trim();
const ariaLabel = attrs => (/\baria-label="([^"]*)"/.exec(attrs)?.[1] ?? "").trim();

// Controls a person or a browser driver addresses by role: buttons, native
// disclosure summaries, and links.
function controls(markup) {
  return [...markup.matchAll(/<(button|summary|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)]
    .map(([, tag, attrs, inner]) => ({ tag, attrs, inner }));
}
const unnamedControls = markup => controls(markup)
  .filter(({ attrs, inner }) => !ariaLabel(attrs) && !textOf(inner))
  .map(({ tag, attrs }) => `<${tag}${attrs}>`);

test("every control in the sidebar shell has an accessible name", () => {
  assert.ok(sidebar, "the sidebar markup must be present to scan it");
  assert.deepEqual(unnamedControls(sidebar), []);
});

test("the scan detects what it claims to", () => {
  // A gate over clean markup proves nothing until it has been shown to fail.
  const planted = `<div id="room-sidebar">
    <button><span aria-hidden="true">+</span></button>
    <summary aria-label="Invite people"><span aria-hidden="true">+</span></summary>
    <button>Connect agent</button>
  </div>`;
  assert.deepEqual(unnamedControls(planted), ["<button>"]);
});

test("member rows are named by person, kind and status", () => {
  const rows = [
    [{ displayName: "Ada", kind: "agent" }, "Working", "Ada, agent, Working"],
    [{ displayName: "Maya", kind: "human" }, "Listening", "Maya, human, Listening"],
    [{ displayName: "Old seat", kind: "agent" }, "", "Old seat, agent"],
  ];
  let markup = "";
  for (const [member, status, expected] of rows) {
    assert.equal(memberRowName(member, status), expected);
    markup += `<div class="presence-member" tabindex="-1" role="group" aria-label="${expected}">`
      + `<details><summary aria-label="Member options for ${member.displayName}"><span aria-hidden="true">···</span></summary></details>`
      + `</div>`;
  }
  assert.deepEqual(unnamedControls(markup), []);
  for (const [, , expected] of rows) assert.match(markup, new RegExp(`aria-label="${expected}"`));
});
