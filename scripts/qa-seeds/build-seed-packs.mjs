#!/usr/bin/env node
// Builds the QA wave seed packs (see scripts/qa-seeds/README.md).
//
//   node scripts/qa-seeds/build-seed-packs.mjs --out <dir> [--pack clean|grown|corrupt|adversarial|all] [--force] [--bulk-target <bytes>]
//   (--bulk-target shrinks the grown/adversarial bulk fills for smoke
//   builds; shipped packs always use the builders' default targets.)
//
// Each pack lands in <dir>/<pack>/ as room.sqlite + manifest.json +
// credentials.json (0600). Packs are build artifacts: lanes clone the pack
// directory and boot their own server against the clone — the pack itself
// is never mutated. A failed build removes its partial pack directory.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClean } from "./lib/pack-clean.mjs";
import { buildGrown } from "./lib/pack-grown.mjs";
import { buildCorrupt } from "./lib/pack-corrupt.mjs";
import { buildAdversarial } from "./lib/pack-adversarial.mjs";

const BUILDERS = { clean: buildClean, grown: buildGrown, corrupt: buildCorrupt, adversarial: buildAdversarial };

function parseArgs(argv) {
  const args = { pack: "all", out: process.env.QA_SEEDS_OUT ?? join(tmpdir(), "qa-seed-packs"), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pack") args.pack = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--bulk-target") args.bulkTargetBytes = Number(argv[++i]);
    else if (argv[i] === "--force") args.force = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (args.pack !== "all" && !BUILDERS[args.pack]) throw new Error(`unknown pack: ${args.pack}`);
  return args;
}

function appSha() {
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}

export async function buildSeedPacks({ pack = "all", out, force = false, bulkTargetBytes } = {}) {
  const names = pack === "all" ? Object.keys(BUILDERS) : [pack];
  const sha = appSha();
  const built = [];
  for (const name of names) {
    const packDir = join(out, name);
    if (existsSync(packDir)) {
      if (!force) throw new Error(`pack directory already exists: ${packDir} (pass --force to rebuild)`);
      rmSync(packDir, { recursive: true, force: true });
    }
    mkdirSync(packDir, { recursive: true });
    try {
      const manifest = await BUILDERS[name](packDir, { appSha: sha, bulkTargetBytes });
      built.push({ pack: name, dir: packDir, manifest });
      console.log(`seed pack ${name}: ${packDir} (app ${sha.slice(0, 12)})`);
    } catch (error) {
      rmSync(packDir, { recursive: true, force: true });
      throw new Error(`seed pack ${name} failed and was cleaned up: ${error.message}`, { cause: error });
    }
  }
  return built;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildSeedPacks(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
