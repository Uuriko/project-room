// BU-01 (empty states): the room Overview dialog is a human's first orientation
// surface. Every empty state there must orient, not decorate:
//   (a) say what goes here,
//   (b) say why it is empty right now,
//   (c) say what to do next.
// This test pins that contract at the source-copy level (the same convention
// as tests/room-roster.test.js), because renderRoomOverview is DOM-bound and
// not importable.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(checkout, "src/app.js"), "utf8");

function stringLiterals(source) {
  return [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
}

// In renderRoomOverview, section(heading, rows, empty) passes the empty copy
// as the third argument, so it is the last string literal before the sibling
// sections resume (a section call ends with `")` then `+`). The last section
// (Recent results) ends the whole renderContent call with `"));` instead.
function sectionEmptyCopy(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} section not found in src/app.js`);
  const tail = source.slice(start + marker.length);
  let end = tail.indexOf("+ section(");
  if (end === -1) end = tail.indexOf("));");
  assert.ok(end !== -1, `could not find end of ${marker} section call`);
  const strings = stringLiterals(tail.slice(0, end));
  assert.ok(strings.length, `no string literals in ${marker} section call`);
  return strings[strings.length - 1];
}

function purposeEmptyCopy(source) {
  const m = source.match(/orientation\.purpose \|\| "((?:[^"\\]|\\.)*)"/);
  assert.ok(m, "room-overview purpose fallback not found in src/app.js");
  return m[1];
}

const copies = {
  purpose: purposeEmptyCopy(app),
  nextForYou: sectionEmptyCopy(app, 'section("Next for you",'),
  activeWork: sectionEmptyCopy(app, 'section(`Active work'),
  decisions: sectionEmptyCopy(app, 'section("Recent decisions",'),
  results: sectionEmptyCopy(app, 'section("Recent results",'),
};

test("purpose empty state says what goes here and who sets it", () => {
  assert.match(copies.purpose, /purpose/i, `does not name what goes here: ${copies.purpose}`);
  assert.match(copies.purpose, /owner/i, `does not say who sets it: ${copies.purpose}`);
});

test("Next for you empty state orients a fresh identity with no claims", () => {
  assert.match(copies.nextForYou, /attention/i, `does not say why it is empty: ${copies.nextForYou}`);
  assert.match(copies.nextForYou, /claim/i, `no next step to claim work: ${copies.nextForYou}`);
  assert.match(copies.nextForYou, /board/i, `next step does not point at the Board: ${copies.nextForYou}`);
});

test("Active work empty state says where active claims appear", () => {
  assert.match(copies.activeWork, /active/i, `does not name what goes here: ${copies.activeWork}`);
  assert.match(copies.activeWork, /claim/i, `no next step to claim work: ${copies.activeWork}`);
  assert.match(copies.activeWork, /board/i, `next step does not point at the Board: ${copies.activeWork}`);
});

test("Recent decisions empty state says decisions come from the room owner", () => {
  assert.match(copies.decisions, /decision/i, `does not name what goes here: ${copies.decisions}`);
  assert.match(copies.decisions, /owner/i, `does not say who records decisions: ${copies.decisions}`);
});

test("Recent results empty state says what goes here (finished work / results)", () => {
  assert.match(copies.results, /result/i, `does not name what goes here: ${copies.results}`);
  assert.match(copies.results, /finish/i, `does not say results come from finished work: ${copies.results}`);
});

test("Recent results empty state gives a next step (claim work on the Board)", () => {
  assert.match(copies.results, /claim/i, `no next step to claim work: ${copies.results}`);
  assert.match(copies.results, /board/i, `next step does not point at the Board: ${copies.results}`);
});

test("Recent results empty state is honest about pay (reputation receipts, not cash)", () => {
  assert.match(copies.results, /reputation receipt/i, `no honest-pay sentence: ${copies.results}`);
});
