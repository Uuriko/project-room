import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyJoinSuccessCopy, joinSuccessCopy } from "../src/join.js";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../join.html"), "utf8");

test("GET /join.html success screen has no agent-key lecture and keeps the key in details", () => {
  assert.doesNotMatch(html, /Save your access key too/);
  assert.doesNotMatch(html, /agent tooling, not this browser/);
  assert.match(html, /<details class="join-key-details">/);
  const secretAt = html.indexOf('id="join-secret"');
  const detailsAt = html.indexOf('<details class="join-key-details">');
  const detailsEnd = html.indexOf("</details>", detailsAt);
  assert.ok(detailsAt >= 0 && detailsEnd > detailsAt);
  assert.ok(secretAt > detailsAt && secretAt < detailsEnd);
  assert.match(html, /id="join-open-room" class="button primary"/);
  assert.match(html, /You&rsquo;re in,/);
});

test("applyJoinSuccessCopy writes joinSuccessCopy onto the success screen", () => {
  const copy = joinSuccessCopy();
  const openEl = { textContent: "Stay" };
  const summary = { textContent: "Lecture" };
  const hint = { textContent: "Long hint" };
  const heading = { childNodes: [{ textContent: "Welcome, " }] };
  const root = {
    getElementById: id => (id === "join-open-room" ? openEl : null),
    querySelector: sel => {
      if (sel === "#join-open-room") return openEl;
      if (sel === "details.join-key-details summary") return summary;
      if (sel === "details.join-key-details .form-hint") return hint;
      if (sel === "#join-success h1") return heading;
      return null;
    }
  };
  assert.deepEqual(applyJoinSuccessCopy(root), copy);
  assert.equal(openEl.textContent, copy.openRoom);
  assert.equal(summary.textContent, copy.keySummary);
  assert.equal(hint.textContent, copy.keyHint);
  assert.match(heading.childNodes[0].textContent, /You're in/);
});
