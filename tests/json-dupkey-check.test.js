// FIX-36 (WAVE-300 ranked-fixes burn-down): CI duplicate-key gate for
// strings/en.json and other authoritative JSON configs. JSON.parse silently
// keeps the LAST value of a duplicated key, so a clean merge that repeats an
// i18n key in two branches passes every existing test while silently dropping
// a string (COLLIDE-3 case 2c). The gate in scripts/json-dupkey-check.mjs
// parses with a duplicate-key-detecting tokenizer and fails loudly, naming
// every duplicated key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findDuplicateKeys } from "../scripts/json-dupkey-check.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const script = join(root, "scripts", "json-dupkey-check.mjs");

const withFiles = (files, fn) => {
  // Honor TMPDIR (scripts/test-env.sh points it at the worktree-local .tmp/;
  // the shared /tmp tmpfs is near-full) like the rest of the suite.
  const base = process.env.TMPDIR || tmpdir();
  const dir = mkdtempSync(join(base, "dupkey-gate-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("FIX-36: findDuplicateKeys reports a duplicated key with its path and line", () => {
  const dupes = findDuplicateKeys('{\n  "a": 1,\n  "b": {"c": 1, "c": 2},\n  "a": 3\n}\n');
  assert.equal(dupes.length, 2);
  const byKey = Object.fromEntries(dupes.map((d) => [d.path, d]));
  assert.equal(byKey["a"].line, 4);
  assert.equal(byKey["b.c"].line, 3);
});

test("FIX-36: same key in sibling objects is not a duplicate", () => {
  assert.deepEqual(findDuplicateKeys('{"x": {"k": 1}, "y": {"k": 2}}'), []);
});

test("FIX-36: clean file, arrays, escaped quotes, and whitespace tricks pass", () => {
  assert.deepEqual(findDuplicateKeys('{"arr": [{"k": 1}, {"k": 2}], "s": "a\\"b: c"}'), []);
  assert.deepEqual(findDuplicateKeys('{\n  "k" : 1,\n  "j": {"k" : 2}\n}'), []);
});

test("FIX-36: triple repeat is reported once with the repeat count", () => {
  const dupes = findDuplicateKeys('{"k": 1, "k": 2, "k": 3}');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].count, 3);
});

test("FIX-36: gate fails on a fixture with a duplicate key and names the key", () => {
  withFiles(
    { "dup.json": '{\n  "email.cta.open_in_room": "Open",\n  "other": 1,\n  "email.cta.open_in_room": "Duplicate wins silently"\n}\n' },
    (dir) => {
      const r = spawnSync(process.execPath, [script, join(dir, "dup.json")], {
        encoding: "utf8",
      });
      assert.equal(r.status, 1);
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(out.includes("dup.json"), "names the file");
      assert.ok(out.includes("email.cta.open_in_room"), "names the duplicated key");
    }
  );
});

test("FIX-36: gate passes on a clean fixture", () => {
  withFiles({ "clean.json": '{"a": 1, "b": {"a": 2}}\n' }, (dir) => {
    const r = spawnSync(process.execPath, [script, join(dir, "clean.json")], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
  });
});

test("FIX-36: gate fails on syntactically invalid JSON", () => {
  withFiles({ "bad.json": '{"a": 1,' }, (dir) => {
    const r = spawnSync(process.execPath, [script, join(dir, "bad.json")], {
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
  });
});

test("FIX-36: default scan covers the real strings/en.json", () => {
  const r = spawnSync(process.execPath, [script, "--list"], { cwd: root, encoding: "utf8" });
  // Exit 0 only when the whole authoritative set is duplicate-free; the
  // assertion here pins the scan's file coverage, not today's verdict.
  const out = `${r.stdout}${r.stderr}`;
  assert.ok(out.includes("strings/en.json"));
  assert.ok(out.includes("package.json"));
});
