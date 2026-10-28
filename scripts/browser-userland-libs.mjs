#!/usr/bin/env node
// Make Playwright's headless Chromium start in a sandbox with no root and no
// system browser libraries (TST-06). The script finds the missing shared
// libraries with ldd, downloads the matching Debian packages, unpacks them
// with `dpkg-deb -x` into a user cache directory and prints the
// LD_LIBRARY_PATH line to use. Nothing is installed system-wide.
//
//   node scripts/browser-userland-libs.mjs --check   # list missing libs, exit 1 if any
//   node scripts/browser-userland-libs.mjs           # fetch + unpack, print export line
//   eval "$(node scripts/browser-userland-libs.mjs --print-env)"
//
// Environment: BROWSER_LIBS_DIR (cache, default ~/.cache/project-room-browser-libs),
// BROWSER_LIBS_MIRROR (default https://deb.debian.org/debian),
// BROWSER_LIBS_SUITE (default VERSION_CODENAME from /etc/os-release, else trixie),
// BROWSER_EXE (override the browser binary to inspect).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// soname -> Debian package (trixie t64 names). Only libraries that slim
// containers usually lack; core libs (libc, glib, nss, x11) are expected.
export const SONAME_TO_DEB = Object.freeze({
  "libatk-1.0.so.0": "libatk1.0-0t64",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0t64",
  "libatspi.so.0": "libatspi2.0-0t64",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXfixes.so.3": "libxfixes3",
  "libXi.so.6": "libxi6",
  "libXrandr.so.2": "libxrandr2",
  "libgbm.so.1": "libgbm1",
  "libdrm.so.2": "libdrm2",
  "libwayland-server.so.0": "libwayland-server0",
  "libxkbcommon.so.0": "libxkbcommon0",
  "libasound.so.2": "libasound2t64",
  "libcups.so.2": "libcups2t64",
  "libnss3.so": "libnss3",
  "libnspr4.so": "libnspr4",
  "libpango-1.0.so.0": "libpango-1.0-0",
  "libcairo.so.2": "libcairo2",
});

export function parseLddMissing(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\S+)\s+=>\s+not found/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function parsePackagesIndex(text, wanted) {
  const want = new Set(wanted);
  const found = new Map();
  for (const block of String(text).split(/\n\n+/)) {
    const name = /^Package: (\S+)$/m.exec(block)?.[1];
    if (!name || !want.has(name) || found.has(name)) continue;
    const file = /^Filename: (\S+)$/m.exec(block)?.[1];
    if (file) found.set(name, file);
  }
  return found;
}

export function packagesFor(missing) {
  const pkgs = []; const unknown = [];
  for (const so of missing) {
    const pkg = SONAME_TO_DEB[so];
    if (!pkg) unknown.push(so); else if (!pkgs.includes(pkg)) pkgs.push(pkg);
  }
  return { pkgs, unknown };
}

export function libDirOf(cacheDir) { return join(cacheDir, "root", "usr", "lib", "x86_64-linux-gnu"); }

function suite() {
  if (process.env.BROWSER_LIBS_SUITE) return process.env.BROWSER_LIBS_SUITE;
  try { return /^VERSION_CODENAME=(\S+)$/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1] || "trixie"; } catch { return "trixie"; }
}

export function findBrowserExe() {
  if (process.env.BROWSER_EXE) return process.env.BROWSER_EXE;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), ".cache", "ms-playwright")].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).sort().reverse();
    for (const d of dirs.filter(n => n.startsWith("chromium_headless_shell-"))) {
      const exe = join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
    for (const d of dirs.filter(n => /^chromium-\d+$/.test(n))) {
      const exe = join(root, d, "chrome-linux64", "chrome");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

function missingFor(exe, libDir) {
  const env = { ...process.env, LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  return parseLddMissing(execFileSync("ldd", [exe], { env, encoding: "utf8" }));
}

async function fetchBuf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function install(exe, cacheDir) {
  const mirror = (process.env.BROWSER_LIBS_MIRROR || "https://deb.debian.org/debian").replace(/\/$/, "");
  const libDir = libDirOf(cacheDir);
  const debDir = join(cacheDir, "debs");
  mkdirSync(debDir, { recursive: true });
  let index = null;
  for (let round = 0; round < 4; round++) {
    const missing = missingFor(exe, libDir);
    if (!missing.length) return { libDir, missing };
    const { pkgs, unknown } = packagesFor(missing);
    if (unknown.length) throw new Error(`no package mapping for: ${unknown.join(", ")} (add it to SONAME_TO_DEB)`);
    if (!index) index = gunzipSync(await fetchBuf(`${mirror}/dists/${suite()}/main/binary-amd64/Packages.gz`)).toString("utf8");
    const files = parsePackagesIndex(index, pkgs);
    for (const pkg of pkgs) {
      const file = files.get(pkg);
      if (!file) throw new Error(`package ${pkg} not in ${suite()} index`);
      const deb = join(debDir, file.split("/").pop());
      if (!existsSync(deb)) writeFileSync(deb, await fetchBuf(`${mirror}/${file}`));
      execFileSync("dpkg-deb", ["-x", deb, join(cacheDir, "root")]);
      console.error(`unpacked ${pkg}`);
    }
  }
  return { libDir, missing: missingFor(exe, libDir) };
}

async function main(argv) {
  if (argv.includes("--help")) { console.log("usage: browser-userland-libs.mjs [--check | --print-env]"); return 0; }
  if (process.platform !== "linux" || process.arch !== "x64") { console.error("browser-userland-libs: linux x64 only; nothing to do"); return 0; }
  const exe = findBrowserExe();
  if (!exe) { console.error("no Playwright Chromium found; run `npx playwright install chromium-headless-shell` first"); return 2; }
  const cacheDir = process.env.BROWSER_LIBS_DIR || join(homedir(), ".cache", "project-room-browser-libs");
  if (argv.includes("--check")) {
    const missing = missingFor(exe, libDirOf(cacheDir));
    console.log(missing.length ? `missing: ${missing.join(" ")}` : "ok: no missing libraries");
    return missing.length ? 1 : 0;
  }
  const { libDir, missing } = await install(exe, cacheDir);
  if (missing.length) { console.error(`still missing: ${missing.join(" ")}`); return 1; }
  console.log(`export LD_LIBRARY_PATH="${libDir}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
}
