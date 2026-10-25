import test from "node:test";
import assert from "node:assert/strict";
import { roomOverviewMarkup, roomOverviewResultsLink } from "../src/room-overview.js";

const words = html => html.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean);

test("an empty overview is one line and hides every section", () => {
  const body = roomOverviewMarkup({ purpose: "  ", sections: [
    { heading: "Next for you", rows: [] },
    { heading: "Recent decisions", rows: [] },
    { heading: "Recent results", rows: [], trailing: roomOverviewResultsLink() },
  ] });
  assert.equal(body.purpose, "");
  assert.match(body.content, /^<p class="form-hint">Nothing recorded yet\.<\/p>$/);
  assert.equal(body.content.includes("<section>"), false);
  assert.equal(body.content.includes("No purpose recorded yet"), false);
  assert.equal(body.content.includes("No decisions recorded yet"), false);
  assert.equal(body.content.includes("No completed results yet"), false);
  assert.equal(body.content.includes("All results"), false);
  assert.ok(words(body.content).length <= 10);
});

test("a filled section is the only section, and a heading cannot inject markup", () => {
  const body = roomOverviewMarkup({
    purpose: "",
    sections: [
      { heading: "Next for you", rows: [] },
      { heading: `Active <work>`, rows: [`<li><a href="/work/1">Agenda</a></li>`] },
      { heading: "Recent decisions", rows: [] },
    ],
  });
  assert.equal(body.purpose, "");
  assert.equal(body.content.includes("Nothing recorded yet"), false);
  assert.equal(body.content.includes("Next for you"), false);
  assert.equal(body.content.includes("Recent decisions"), false);
  assert.match(body.content, /<h3>Active &lt;work&gt;<\/h3>/);
  assert.match(body.content, /<a href="\/work\/1">Agenda<\/a>/);
  assert.equal([...body.content.matchAll(/<section>/g)].length, 1);
});

test("a purpose with no sections does not add the empty line", () => {
  const body = roomOverviewMarkup({
    purpose: "Ship the small version",
    instructions: { revision: 2, updatedAt: "Jan 2" },
    sections: [{ heading: "Recent results", rows: [] }],
  });
  assert.equal(body.purpose, "Ship the small version");
  assert.match(body.content, /Room instructions · version 2 · Jan 2/);
  assert.equal(body.content.includes("<section>"), false);
  assert.equal(body.content.includes("Nothing recorded yet"), false);
});

test("the results link is present only on a results section that has rows", () => {
  const link = roomOverviewResultsLink();
  const empty = roomOverviewMarkup({ sections: [{ heading: "Recent results", rows: [], trailing: link }] });
  assert.equal(empty.content.includes("Open the room's Results"), false);
  const filled = roomOverviewMarkup({ sections: [{ heading: "Recent results", rows: ["<li>Done</li>"], trailing: link }] });
  assert.match(filled.content, /data-open-results/);
  assert.match(filled.content, /Open the room's Results/);
});
