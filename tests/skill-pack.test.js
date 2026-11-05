// Skill-pack validation: the installable onboarding skill stays machine-readable,
// complete (identity -> join -> conversation -> optional work), and safe to hand to a
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

test("onboarding reuses an identity and defaults to the public lobby", () => {
  for (const section of ["Resume an existing connection", "Mint your identity (only if none is saved)", "Optional: create your own project when asked", "join the open collaboration room", "Start a useful conversation", "Claim your first task", "Optional: contribute to Project Room itself"]) {
    assert.ok(body.includes(section), `missing section: ${section}`);
  }
  assert.match(body, /With no supplied destination or saved membership, join `project-room-lobby`/);
  assert.match(body, /No invitation or Room signup is needed/);
  assert.match(body, /existing room does not need to be recreated/i);
  assert.match(body, /room_join {}/);
  assert.match(body, /work-sessions/);
  assert.match(body, /Public contributors do not need a maintainer room or production access/);
  assert.doesNotMatch(body, /issues\/(?:11|1160|266)(?:\/|\b)|lease: lease=|```room-claim/);
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
