// MI-012 (Jill master-issues): /join had two fields both labelled "Room link".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("/join field labels are distinct", () => {
  const html = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  const labels = [...html.matchAll(/<label>([^<]+?)\s*<(?:input|textarea|select)/g)].map(m => m[1].trim());
  assert.ok(labels.includes("Room link"));
  assert.ok(labels.includes("Room to request (link or ID)"));
  assert.equal(new Set(labels).size, labels.length, `duplicate labels: ${labels}`);
});
