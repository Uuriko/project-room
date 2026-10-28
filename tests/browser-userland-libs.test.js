import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { SONAME_TO_DEB, parseLddMissing, parsePackagesIndex, packagesFor, libDirOf } from "../scripts/browser-userland-libs.mjs";

test("parseLddMissing returns unique missing sonames in order", () => {
  const text = "\tlinux-vdso.so.1 (0x0)\n\tlibatk-1.0.so.0 => not found\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0)\n\tlibgbm.so.1 => not found\n\tlibatk-1.0.so.0 => not found\n";
  assert.deepEqual(parseLddMissing(text), ["libatk-1.0.so.0", "libgbm.so.1"]);
  assert.deepEqual(parseLddMissing(""), []);
});

test("parsePackagesIndex maps wanted packages to pool filenames", () => {
  const idx = "Package: libxi6\nVersion: 1\nFilename: pool/main/libx/libxi/libxi6_1_amd64.deb\n\nPackage: other\nFilename: pool/x.deb\n\nPackage: libgbm1\nFilename: pool/main/m/mesa/libgbm1_2_amd64.deb\n";
  const m = parsePackagesIndex(idx, ["libxi6", "libgbm1", "absent"]);
  assert.equal(m.get("libxi6"), "pool/main/libx/libxi/libxi6_1_amd64.deb");
  assert.equal(m.get("libgbm1"), "pool/main/m/mesa/libgbm1_2_amd64.deb");
  assert.equal(m.has("absent"), false);
  assert.equal(m.has("other"), false);
});

test("packagesFor covers the libraries a slim Debian sandbox lacks", () => {
  // Observed 2026-10-09 with chromium_headless_shell-1234 on Debian 13 slim.
  const observed = ["libatk-1.0.so.0", "libatk-bridge-2.0.so.0", "libXcomposite.so.1", "libXdamage.so.1", "libXfixes.so.3", "libgbm.so.1", "libxkbcommon.so.0", "libasound.so.2", "libatspi.so.0", "libXi.so.6"];
  const { pkgs, unknown } = packagesFor(observed);
  assert.deepEqual(unknown, []);
  assert.equal(pkgs.length, observed.length);
  assert.deepEqual(packagesFor(["libnope.so.9"]).unknown, ["libnope.so.9"]);
  for (const pkg of Object.values(SONAME_TO_DEB)) assert.match(pkg, /^[a-z0-9.+-]+$/);
});

test("libDirOf and --help need no network", () => {
  assert.equal(libDirOf("/c"), "/c/root/usr/lib/x86_64-linux-gnu");
  const r = spawnSync(process.execPath, ["scripts/browser-userland-libs.mjs", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage/);
});
