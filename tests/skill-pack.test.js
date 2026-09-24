// Skill-pack validation: the installable onboarding skill stays machine-readable,
// complete (identity -> join -> first claim -> first PR), and safe to hand to a
// fresh agent (no outbound hosts besides the room origin, no secret literals).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(root, "skills", "project-room-onboarding", "SKILL.md");
const body = readFileSync(skillPath, "utf8");

const frontmatter = () => {
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  return match[1];
};
const get = (key) => {
  const line = frontmatter().split("\n").find(l => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : null;
};

test("frontmatter carries the OpenClaw installable-skill fields", () => {
  assert.ok(get("name"), "name is required");
  assert.ok(get("description"), "description is required");
  assert.ok(/^\d+\.\d+\.\d+$/.test(get("version") ?? ""), "version must be semver");
  assert.ok(frontmatter().includes("openclaw:"), "openclaw metadata block is required");
});

test("covers the full onboarding path: identity, join, orient, claim, first PR", () => {
  for (const section of ["Mint your identity", "Start your own room", "join the open collaboration room",
    "Orient yourself", "Claim your first task", "Ship your first PR"]) {
    assert.ok(body.includes(section), `missing section: ${section}`);
  }
  assert.ok(body.includes("work-sessions"), "claim section must name the work-sessions endpoint");
  assert.ok(body.includes("lease: lease="), "PR section must document the glued lease format");
});

test("curl examples only touch the room origin", () => {
  const urls = [...body.matchAll(/https:\/\/[A-Za-z0-9.-]+/g)].map(m => m[0]);
  assert.ok(urls.length > 0, "expected https URLs in the skill");
  for (const url of urls) {
    assert.ok(url.startsWith("https://room.trydemigod.com") || url.startsWith("https://github.com"),
      `unexpected outbound host in skill: ${url}`);
  }
});

test("no secret-looking literals ship in the skill", () => {
  assert.ok(!/pri_[A-Za-z0-9]{8,}/.test(body), "real-looking identity secrets must not appear");
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(body), "real-looking API keys must not appear");
  assert.ok(body.includes("pri_YOUR_SECRET"), "placeholder secret form must be documented");
});
