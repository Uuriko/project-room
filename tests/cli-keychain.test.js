// The room CLI keeps the identity secret in the OS keychain when it can.
// Fake security/secret-tool binaries on PATH record what they were given.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainStore } from "../cli/keychain.mjs";
import { loadSecret, rememberSecret } from "../cli/auth.mjs";

const SECRET = "fake-identity-secret-0123456789";

function fakeTools(script) {
  const dir = mkdtempSync(join(tmpdir(), "room-keychain-"));
  for (const name of ["security", "secret-tool"]) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nLOG="${dir}"\n${script}\n`);
    chmodSync(file, 0o755);
  }
  return { dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
}

test("macOS store keeps the secret out of the security arguments", async () => {
  const { dir, env } = fakeTools(`
echo "$@" >> "$LOG/argv"
case "$1" in
  -i) cat > "$LOG/stdin" ;;
  find-generic-password) sed -n 's/.*-w "\\(.*\\)"$/\\1/p' "$LOG/stdin" ;;
esac
exit 0`);
  try {
    assert.equal(await keychainStore("agent", SECRET, env, { platform: "darwin" }), true);
    assert.ok(!readFileSync(join(dir, "argv"), "utf8").includes(SECRET), "secret must not appear in argv");
    assert.match(readFileSync(join(dir, "stdin"), "utf8"), /^add-generic-password -U -s "project-room" -a "agent" -w ".+"\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("macOS store reports failure when the keychain did not keep the value", async () => {
  const { dir, env } = fakeTools(`case "$1" in -i) cat >/dev/null ;; esac\nexit 0`);
  try {
    assert.equal(await keychainStore("agent", SECRET, env, { platform: "darwin" }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed store clears the old keychain entry so the fresh file secret wins", async () => {
  const { dir, env } = fakeTools(`
case "$1" in
  store) cat >/dev/null; exit 1 ;;
  clear) touch "$LOG/cleared"; exit 0 ;;
  lookup) [ -f "$LOG/cleared" ] && exit 1; echo old-revoked-secret; exit 0 ;;
esac`);
  try {
    assert.equal(await loadSecret("agent", SECRET, env, { platform: "linux" }), "old-revoked-secret");
    assert.equal(await rememberSecret("agent", SECRET, env, { platform: "linux" }), false);
    assert.ok(existsSync(join(dir, "cleared")));
    assert.equal(await loadSecret("agent", SECRET, env, { platform: "linux" }), SECRET);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("secrets with line breaks are never sent to the keychain", async () => {
  const { dir, env } = fakeTools(`touch "$LOG/called"; exit 0`);
  try {
    assert.equal(await keychainStore("agent", "a\nb", env, { platform: "darwin" }), false);
    assert.ok(!existsSync(join(dir, "called")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
