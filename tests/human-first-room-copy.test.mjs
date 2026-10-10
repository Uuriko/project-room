// D1 stranger-onboarding audit: the human onboarding surfaces must describe
// the first-room flow as it actually works. A fresh account does NOT create
// its first room — POST /api/account/ensure-default-room auto-creates
// "My first room" the first time the account panel loads with no rooms
// (RC-2026-09-19-088; src/app.js ensureDefaultRoom; verified live on prod).
// Telling a stranger to "create" their first room sends them to build a
// redundant second room. Contract: every human onboarding surface says the
// first room is set up automatically, and names the sign-in methods the
// welcome screen actually offers (Google or email — password, magic link).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const AUTO = /set up .*automatically|automatically .*set up|created for you automatically/i;

test("about.html: first room is described as automatic, not user-created", () => {
  const about = read("about.html");
  assert.ok(
    !/creates? its first room free/i.test(about),
    "about.html still tells a brand-new account to CREATE its first room — it is auto-created",
  );
  assert.match(about, AUTO, "about.html must say the first room is set up automatically");
  assert.match(about, /My first room/, "about.html must name the auto-created room");
});

test("HUMAN-ONBOARDING.md path 3: first room is automatic", () => {
  const doc = read("docs/HUMAN-ONBOARDING.md");
  const path3 = doc.slice(doc.indexOf("**3. You want your own room.**"));
  assert.ok(
    !/can\s+create its first room free/i.test(path3),
    "path 3 still tells a brand-new account to create its first room from the panel",
  );
  assert.match(path3, AUTO, "path 3 must say the first room is set up automatically");
});

test("HUMAN-ONBOARDING.md path 2: names email sign-in, not Google-only", () => {
  const doc = read("docs/HUMAN-ONBOARDING.md");
  const path2 = doc.slice(doc.indexOf("**2. You have nothing"), doc.indexOf("**3. You want your own room.**"));
  assert.ok(
    !/Sign in with Google,/.test(path2),
    "path 2 still says Google-only; the welcome screen offers Google or email",
  );
  assert.match(path2, /Google or email/i, "path 2 must name both Google and email sign-in");
});

test("HUMAN-ONBOARDING.md Stuck?: no stale empty-Rooms-list first-room advice", () => {
  const doc = read("docs/HUMAN-ONBOARDING.md");
  const stuck = doc.slice(doc.indexOf("## Stuck?"));
  assert.ok(
    !/lands you on an empty Rooms list/i.test(stuck),
    "Stuck? still describes an empty Rooms list for fresh sign-ins — auto-create fills it",
  );
});

test("FAQ.md and INDEX.md: first room is automatic", () => {
  for (const file of ["docs/FAQ.md", "docs/INDEX.md"]) {
    const doc = read(file);
    assert.ok(
      !/can create its first room/i.test(doc),
      `${file} still tells a new account to create its first room`,
    );
    assert.match(doc, AUTO, `${file} must say the first room is set up automatically`);
  }
});

test("index.html New-room hint: first room is automatic", () => {
  const html = read("index.html");
  const hint = html.match(/<p class="form-hint">Your first room[^<]*<\/p>/);
  assert.ok(hint, "New-room form hint is missing");
  assert.ok(
    !/^<p class="form-hint">Your first room is free to create/.test(hint[0]),
    "New-room hint still frames the first room as something to create",
  );
  assert.match(hint[0], AUTO, "New-room hint must say the first room is set up automatically");
});
