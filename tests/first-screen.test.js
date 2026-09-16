import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { firstScreen } from "../scripts/first-screen.mjs";

const index = () => readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("each suppression mechanism is classified for what it is", () => {
  const report = firstScreen(`
    <button id="plain">Plain</button>
    <button id="marked" hidden>Marked</button>
    <section hidden><button id="descendant">Inside hidden section</button></section>
    <dialog><button id="modal">Inside dialog</button></dialog>
    <details><summary id="toggle">Open me</summary><button id="folded">Folded away</button></details>
    <details open><summary id="toggle2">Already open</summary><button id="unfolded">Reachable</button></details>
  `);
  const reason = (id) => [...report.visible, ...report.suppressed].find((c) => c.id === id)?.reason ?? null;

  assert.equal(reason("plain"), null);
  assert.equal(reason("marked"), "hidden attribute");
  assert.equal(reason("descendant"), "inside hidden <section>");
  assert.equal(reason("modal"), "inside <dialog>");
  assert.equal(reason("folded"), "inside collapsed <details>");
  // The summary is the control that opens the disclosure, so it is reachable.
  assert.equal(reason("toggle"), null, "a summary is how a visitor opens the details");
  assert.equal(reason("unfolded"), null, "an open details reveals its contents");
  assert.equal(report.hiddenCount, 2);
});

test("a control is judged by its whole ancestor chain, not its own tag", () => {
  const report = firstScreen(`<div hidden><details><summary id="s">Nested</summary></details></div>`);
  assert.equal(report.visible.length, 0, "a summary inside a hidden ancestor is still unreachable");
  assert.match(report.suppressed[0].reason, /hidden/);
});

test("the real first paint stays small", () => {
  const report = firstScreen(index());
  // The stated principle is to land on one thing and hide the rest. This is the
  // budget that keeps it true. It exists because a fetched text rendering of this
  // page reads as though everything is on screen, which produced a confident and
  // completely wrong claim that the first screen showed twelve controls.
  assert.ok(report.visible.length <= 8,
    `first paint offers ${report.visible.length} controls, which is a firehose:\n` +
    report.visible.map((c) => `  <${c.tag}> ${c.id ?? ""} ${c.label}`).join("\n"));
  assert.ok(report.suppressed.length > 50, "suppression stopped working, or the markup moved");
});

test("the page really is disclosure-first, which is the opposite of what I claimed", () => {
  const report = firstScreen(index());
  const ratio = report.suppressed.length / Math.max(1, report.visible.length);
  assert.ok(ratio > 10, `suppressed-to-visible ratio is only ${ratio.toFixed(1)}`);
});
