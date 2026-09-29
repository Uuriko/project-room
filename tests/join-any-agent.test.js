import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const hostsDir = join(root, "skills/project-room-host-router/hosts");
const classes = JSON.parse(readFileSync(join(root, "skills/project-room-host-router/hosts.json"), "utf8"));
const paste = readFileSync(join(root, "docs/JOIN-ANY-AGENT.md"), "utf8");
const skill = readFileSync(join(root, "skills/project-room-host-router/SKILL.md"), "utf8");
const plan = readFileSync(join(root, "docs/AGENT-HOST-PLAN-2026-09-29.md"), "utf8");

test("every advertised host class has a card and appears in the paste", () => {
  assert.ok(Array.isArray(classes) && classes.length >= 5);
  const files = new Set(readdirSync(hostsDir).filter(name => name.endsWith(".md")).map(name => name.slice(0, -3)));
  for (const name of classes) {
    assert.ok(files.has(name), `missing hosts/${name}.md`);
    assert.match(paste, new RegExp("`" + name + "`"));
    assert.match(skill, new RegExp("hosts/" + name + "\\.md"));
    const card = readFileSync(join(hostsDir, `${name}.md`), "utf8");
    assert.match(card, new RegExp("^# " + name, "m"));
    assert.doesNotMatch(card, /pri_[A-Za-z0-9_-]{20,}/);
  }
});

test("paste packet forbids secrets and points at live discovery", () => {
  assert.match(paste, /untrusted data/);
  assert.match(paste, /pri_…/);
  assert.doesNotMatch(paste, /pri_[A-Za-z0-9_-]{20,}/);
  assert.match(paste, /room\.trydemigod\.com\/llms\.txt/);
  assert.match(paste, /agent-card\.json/);
});

test("plan names the router and the Grok host without mixing doors", () => {
  assert.match(plan, /JOIN-ANY-AGENT\.md/);
  assert.match(plan, /grok-room-host/);
  assert.match(plan, /github-issue/);
  assert.match(plan, /Doors are adapters/);
});
