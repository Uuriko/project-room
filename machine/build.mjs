#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

function check() {
  const files = walk(root);
  let failed = 0;
  for (const path of files) {
    const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    if (result.status !== 0) {
      failed += 1;
      process.stderr.write(result.stderr || `${path} failed\n`);
    }
  }
  if (failed) {
    console.error(`machine check failed (${failed})`);
    process.exit(1);
  }
  console.log(`machine check ok (${files.length} files)`);
}

function assertImportClosure(names) {
  const inPack = new Set(names);
  const missing = new Set();
  const seen = new Set();
  const queue = ["machine/bin/room-machine.mjs"];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let source;
    try {
      source = readFileSync(join(repo, rel), "utf8");
    } catch {
      missing.add(rel);
      continue;
    }
    for (const match of source.matchAll(/(?:import|export)[^'"]*from\s*["']([^"']+)["']/g)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue; // bare/node specifiers ship with the runtime
      const withExt = /\.[a-z]+$/i.test(spec) ? spec : `${spec}.mjs`;
      const resolved = join(dirname(rel), withExt).split("\\").join("/");
      if (!inPack.has(resolved)) missing.add(`${resolved} (imported by ${rel})`);
      else if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  if (missing.size) {
    for (const m of missing) console.error(`pack is missing import: ${m}`);
    process.exit(1);
  }
}

function pack() {
  const names = [
    "machine/bin/room-machine.mjs",
    "machine/versions.json",
    "machine/PROTOCOL.md",
    "machine/README.md",
    "machine/build.mjs",
    "machine/launchd/com.uuriko.room-machine.plist",
    ...walk(join(root, "lib")).map(path => relative(repo, path).split("\\").join("/")),
    ...walk(join(root, "bot")).map(path => relative(repo, path).split("\\").join("/")),
  ];
  // The CLI statically imports ../bot/*.mjs: fail the pack if any relative
  // import reachable from the entry point is missing from the pack set.
  assertImportClosure(names);
  const result = spawnSync("tar", ["-czf", "-", "-C", repo, ...names], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  const bytes = result.stdout;
  // spawnSync encoding buffer still returns Buffer. Confirm gzip header.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    console.error("payload tar is not gzip");
    process.exit(1);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const b64 = bytes.toString("base64");
  const installPath = join(root, "install.sh");
  let text = readFileSync(installPath, "utf8");
  text = text.replace(/^PAYLOAD_SHA256=".*"$/m, `PAYLOAD_SHA256="${sha}"`);
  text = text.replace(/^PAYLOAD_B64=".*"$/m, `PAYLOAD_B64="${b64}"`);
  if (!text.includes(`PAYLOAD_SHA256="${sha}"`) || !text.includes("PAYLOAD_B64=\"")) {
    console.error("install.sh is missing PAYLOAD_SHA256 or PAYLOAD_B64");
    process.exit(1);
  }
  writeFileSync(installPath, text);
  console.log(`packed ${bytes.length} bytes sha256 ${sha}`);
}

const command = process.argv[2] ?? "--check";
if (command === "--check") check();
else if (command === "--pack") pack();
else {
  console.error("usage: node machine/build.mjs --check|--pack");
  process.exit(2);
}
