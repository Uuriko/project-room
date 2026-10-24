import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #3771 remainder (TRAIN-W30-C leg 2): the front-door batch B-1 made blocked
// submits loud on the session-one forms and marked the new-work labels, but
// the action dialog's required fields stayed unmarked, the status message
// named a <select> by pouring every option's text out of its label, and no
// blocked submit ever focused the field it named. These specimens pin the
// completed affordance at the level app.js allows without a browser (the
// front-door-batch.test.js standard): the builders and the field-name
// helper are pure, so they are extracted and EXECUTED here; the rest
// assert the shipped source carries the fix.

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const app = read("src/app.js");
const indexHtml = read("index.html");
const esc = value => String(value);

// Slice a top-level declaration out of app.js and evaluate it. `opener` is
// the exact start of the declaration; the slice ends at the first line
// that closes it at column 0 for its kind.
function extract(source, opener, closer) {
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, `declaration present: ${opener.slice(0, 48)}`);
  const end = source.indexOf(closer, start);
  assert.notEqual(end, -1, `declaration terminates: ${opener.slice(0, 48)}`);
  return source.slice(start, end + closer.length);
}

function loadBuilders() {
  const mark = extract(app, "const requiredMark =", ";\n");
  const field = extract(app, "const field = (name, label", ";\n");
  const area = extract(app, "const area = (name, label", ";\n");
  return new Function("esc", `${mark}\n${field}\n${area}\nreturn { field, area };`)(esc);
}

function loadRequiredFieldName() {
  const start = app.indexOf("function requiredFieldName(field) {");
  assert.notEqual(start, -1, "requiredFieldName helper present in app.js");
  let depth = 0, end = -1;
  for (let i = app.indexOf("{", start); i < app.length; i++) {
    if (app[i] === "{") depth++;
    if (app[i] === "}" && --depth === 0) { end = i; break; }
  }
  assert.notEqual(end, -1, "requiredFieldName terminates");
  return new Function(`${app.slice(start, end + 1)}\nreturn requiredFieldName;`)();
}

test("builders mark required fields in the label and keep the DOM requirement honest", () => {
  const { field, area } = loadBuilders();
  assert.match(field("evidenceUrl", "Evidence URL (HTTPS, display only)", "url"), /Evidence URL \(HTTPS, display only\) \(required\)<input name="evidenceUrl" type="url" required/);
  assert.match(area("summary", "What did you complete?"), /What did you complete\? \(required\)<textarea name="summary" required/);
  // A label that already states the requirement in prose is not double-marked.
  const signed = field("signedEvidence", "Signed evidence JSON (room-signed-evidence/1 — required; paste the object your agent identity key signed)");
  assert.doesNotMatch(signed, /\) \(required\)<input/);
  assert.match(signed, /required/);
  // The renew progress message id is optional evidence: no DOM requirement,
  // and its label keeps saying so (the handler accepts an empty heartbeat).
  const progress = field("progressMessageId", "Progress message id (optional evidence)", "text", false);
  assert.doesNotMatch(progress, / required/);
  assert.match(progress, /Progress message id \(optional evidence\)<input name="progressMessageId" type="text"/);
});

test("hand-written required labels in the action dialog and decision form are marked", () => {
  assert.match(app, /Produced by \(required\)<select name="producerId" required/);
  assert.match(app, /Result \(required\)<select name="result" required/);
  assert.match(app, /Decision \(required\)<select name="decision" required/);
  assert.match(app, /What would help\? \(required\)<textarea name="scope" required/);
  assert.match(app, /Available for \(required\)<select name="duration" required/);
  assert.match(app, /How can you help\? \(required\)<textarea name="plan" required/);
  assert.match(app, /Note \(required\)<textarea name="reason" required/);
  assert.match(indexHtml, /<span>Decision \(required\)<\/span><textarea id="decision-statement-input"/);
});

test("requiredFieldName names the field by its label's own words, never the control's content", () => {
  const requiredFieldName = loadRequiredFieldName();
  const textNode = text => ({ nodeType: 3, textContent: text });
  const element = textContent => ({ nodeType: 1, textContent });
  // A select inside its label: the old derivation read the label's full
  // textContent and poured every option into the message.
  const selectField = {
    closest: () => ({
      childNodes: [textNode("Produced by (required)"), element("Choose producerOutside person or AIUnknown / not reported")],
      querySelector: () => null,
    }),
    getAttribute: () => null, name: "producerId",
  };
  assert.equal(requiredFieldName(selectField), "Produced by (required)");
  // New-work shape: the words live in a <span> inside the label.
  const spanField = {
    closest: () => ({
      childNodes: [element("Request (required)")],
      querySelector: selector => selector === "span" ? { textContent: "Request (required)" } : null,
    }),
    getAttribute: () => null, name: "title",
  };
  assert.equal(requiredFieldName(spanField), "Request (required)");
  // Fallbacks: aria-label, then the control's name, then a generic phrase.
  assert.equal(requiredFieldName({ closest: () => null, getAttribute: attr => attr === "aria-label" ? "Assignee" : null, name: "assigneeId" }), "Assignee");
  assert.equal(requiredFieldName({ closest: () => null, getAttribute: () => null, name: "title" }), "title");
  assert.equal(requiredFieldName({ closest: () => null, getAttribute: () => null, name: "" }), "A required field");
});

test("the blocked-submit listener acts on the first invalid control and focuses it", () => {
  const start = app.indexOf('addEventListener("invalid"');
  assert.notEqual(start, -1, "invalid listener present");
  const block = app.slice(app.lastIndexOf("for (const [formSelector, statusSelector]", start), app.indexOf("}, true);", start) + "}, true);".length);
  assert.match(block, /requiredFieldName\(field\)/, "the message names the field via the helper");
  assert.match(block, /firstInvalid/, "the listener identifies the first invalid control");
  assert.match(block, /field !== firstInvalid/, "later invalid controls in the same submit do not re-fire it");
  assert.match(block, /field\.focus\?\.\(\)/, "the named field is focused");
});
