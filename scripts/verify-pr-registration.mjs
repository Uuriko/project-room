// Diff-keyed registration checklist for `npm run verify:pr` (PERF-10X L14).
//
// Hosted CI bounces PRs on registration/bookkeeping omissions that no single
// local command used to surface: a new server module with no test reference
// (untested-modules), a module in the packaged import closure that is not in
// the runtime-package allowlist, a public asset registered in one asset list
// but not its twin, a new open route missing from ROUTE-AUTH-TABLE /
// INVITE-ONLY-CHECKLIST / the invite-only PROBES, a new table missing from
// the writer-fence census or the purge registry, a browser check that was
// never added to package.json's test:browser list, an unpinned workflow
// action. This module turns each of those into a checklist item keyed to the
// shape of the PR's diff.
//
// Items have three statuses:
//   fail  - mechanically verified missing registration; verify:pr exits 1.
//   pass  - mechanically verified present.
//   check - a conditional requirement this script cannot prove from the
//           tree alone; printed so the author attests to it instead of
//           discovering it in a hosted round. Never counted as a pass of
//           the underlying hosted gate.
//
// Usage: node scripts/verify-pr-registration.mjs [--base <ref>]
//        node scripts/verify-pr-registration.mjs --files server/foo.mjs,src/bar.js
// The pure builder (buildRegistrationItems) takes a snapshot object so tests
// can exercise every rule without a git checkout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const ROUTE_SOURCE_FILES = new Set([
  "server/http.mjs",
  "server/discoverability.mjs",
  "server/routes/table.mjs",
  "docs/openapi.yaml",
]);

function item(file, rule, status, detail) {
  return { file, rule, status, detail };
}

export function buildRegistrationItems(snapshot) {
  const items = [];
  const changed = snapshot.changed ?? [];
  const addedLines = snapshot.addedLines ?? new Map();
  const linesOf = path => addedLines.get(path) ?? "";

  for (const { path, status } of changed) {
    const isAdded = status === "A";

    // --- New server module: test reference + packaged-closure registration.
    if (isAdded && path.startsWith("server/") && path.endsWith(".mjs")) {
      const rel = path.slice("server/".length);
      if ((snapshot.untestedServerModules ?? new Set()).has(rel)) {
        items.push(item(path, "tests/*.test.js direct import", "fail",
          "no tests/*.test.js file directly imports or path-references this module; add a test that imports it (scripts/untested-modules-lint.mjs enforces the same rule — do not extend its grandfather list)"));
      } else {
        items.push(item(path, "tests/*.test.js direct import", "pass",
          "a tests/*.test.js file references this module"));
      }
    }

    // --- Packaged import closure: runtime-package + candidate fixture.
    if (isAdded && /\.(mjs|js)$/.test(path) &&
        /^(server|client|src|scripts|cloudflare)\//.test(path) &&
        !/\.check\.mjs$/.test(path) && !/\.test-fixture\.mjs$/.test(path)) {
      const closures = snapshot.packagedClosures ?? new Map();
      let inClosureOf = null;
      for (const [entry, closure] of closures) {
        if (closure.has(path)) { inClosureOf = entry; break; }
      }
      if (inClosureOf && !(snapshot.runtimeAllowed ?? new Set()).has(path)) {
        items.push(item(path, "runtime-package registration", "fail",
          `imported (transitively) by ${inClosureOf} but not in the allowlist in scripts/runtime-package.mjs; register it there — candidate-runtime-fixture inherits allowlisted files from the runtime manifest automatically`));
      } else if (inClosureOf) {
        items.push(item(path, "runtime-package registration", "pass",
          `in the import closure of ${inClosureOf} and present in scripts/runtime-package.mjs; scripts/candidate-runtime-fixture.mjs needs no separate entry (it starts from the runtime manifest)`));
      } else {
        items.push(item(path, "runtime-package registration", "check",
          "not in any packaged entrypoint's import closure today, so no registration is required yet; if packaged code imports it later, register it in scripts/runtime-package.mjs (candidate-runtime-fixture then inherits it), and if a candidate/frozen fixture test loads it directly, also add it to scripts/candidate-runtime-fixture.mjs"));
      }
    }

    // --- New browser-served source file: the two asset lists stay twins.
    if (isAdded && path.startsWith("src/")) {
      const publicAssets = snapshot.publicAssets ?? [];
      if (publicAssets.includes(path)) {
        if ((snapshot.buildAssetsSource ?? "").includes(path) && (snapshot.runtimeAllowed ?? new Set()).has(path)) {
          items.push(item(path, "public-asset registration", "pass",
            "present in server/public-assets.mjs, cloudflare/build-assets.mjs and the runtime-package allowlist"));
        } else {
          items.push(item(path, "public-asset registration", "fail",
            "listed in server/public-assets.mjs but missing from cloudflare/build-assets.mjs or the runtime-package allowlist; the three registrations must move together (tests/runtime-package.test.js pins publicAssets deep-equal to the Cloudflare asset list)"));
        }
      } else if ((snapshot.importedByPublicAssets ?? new Set()).has(path)) {
        items.push(item(path, "public-asset registration", "fail",
          "imported by a browser-served public asset but not listed in server/public-assets.mjs; register it there, in cloudflare/build-assets.mjs, and in the runtime-package allowlist"));
      } else {
        items.push(item(path, "public-asset registration", "check",
          "not a browser-served public asset and not imported by one; if it becomes browser-served, register it in server/public-assets.mjs + cloudflare/build-assets.mjs + scripts/runtime-package.mjs together"));
      }
    }

    // --- Route-defining change: docs, served spec, auth tables, probes.
    if (ROUTE_SOURCE_FILES.has(path) || path.startsWith("server/routes/")) {
      items.push(item(path, "route documentation", "check",
        "route changes require: the route in docs/openapi.yaml (scripts/openapi-gen.mjs --check, in the contract step), the served spec in server/discoverability.mjs, and — for open (security: []) routes — docs/ROUTE-AUTH-TABLE.md + docs/INVITE-ONLY-CHECKLIST.md section 1 + a PROBES entry in tests/invite-only-boundary.test.js; the hard checks below verify the open-route registrations mechanically"));
    }

    // --- New table in a server module: writer-fence + purge censuses.
    if (path.startsWith("server/") && path.endsWith(".mjs")) {
      const created = [...linesOf(path).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["'`]?([a-z][a-z0-9_]*)/gi)]
        .map(m => m[1]);
      for (const table of new Set(created)) {
        if ((snapshot.writerFenceSource ?? "").includes(`"${table}"`)) {
          items.push(item(path, "census pins: writer-fence / recovery / backup parity", "pass",
            `table ${table} is named in server/writer-fence.mjs (applicationTables); server/recovery.mjs, the backup-parity and cold-start censuses derive from that one list — no separate registration exists to update`));
        } else {
          items.push(item(path, "census pins: writer-fence / recovery / backup parity", "fail",
            `new table ${table} is not named in server/writer-fence.mjs; add it to the application-table census there (recovery, backup parity and cold-start derive from it) or to the lazy/unfenced lists with the reason recorded`));
        }
        if ((snapshot.purgeRegistrySource ?? "").includes(`"${table}"`)) {
          items.push(item(path, "census pins: purge/retention registry", "pass",
            `table ${table} is named in server/purge-registry.mjs`));
        } else {
          items.push(item(path, "census pins: purge/retention registry", "fail",
            `new table ${table} is not named in server/purge-registry.mjs; add a purge row (or an explicit retention row) for it there`));
        }
      }
      if (linesOf(path).includes("ADDITIVE_SCHEMA_ENSURES") || linesOf(path).includes("@revision")) {
        items.push(item(path, "census pins: schema-stamp SOURCE_PINS", "check",
          "this diff touches additive schema ensures / @revision stamps; if a helper's stamped source changed, bump its @revision in ADDITIVE_SCHEMA_ENSURES (server/store.mjs) and update SOURCE_PINS in tests/schema-stamp-coverage.test.js — the unit suite asserts the pin map exactly"));
      }
    }

    // --- New browser check script: package.json test:browser registration.
    if (isAdded && path.startsWith("scripts/") && /(?:browser-check|-check)\.mjs$/.test(path)) {
      const source = snapshot.fileContents?.get(path) ?? "";
      if (/playwright/i.test(source)) {
        if ((snapshot.packageJsonSource ?? "").includes(path.split("/").pop())) {
          items.push(item(path, "endpoint-inventory / browser-check registration", "pass",
            "browser check is named in package.json (test:browser), which scripts/browser-ci.mjs and the browser shards read as their inventory"));
        } else {
          items.push(item(path, "endpoint-inventory / browser-check registration", "fail",
            "this script drives a browser but is not named in package.json's test:browser list; hosted browser shards build their inventory from that list, so an unlisted check never runs in CI"));
        }
      }
    }

    // --- Workflow change: action refs are SHA-pinned (contract also checks).
    if (path.startsWith(".github/workflows/")) {
      if (/uses:\s*\S+@v\d/.test(linesOf(path))) {
        items.push(item(path, "workflow action pins", "fail",
          "an added line uses a tag-pinned action ref (uses: ...@vN); pin actions to a full commit SHA — scripts/check-workflow-pins.mjs in the contract step enforces the same rule"));
      } else {
        items.push(item(path, "workflow action pins", "check",
          "workflow changes require every action ref pinned to a full commit SHA; scripts/check-workflow-pins.mjs in the contract step asserts it"));
      }
    }

    // --- New unit test file: discovery is automatic, say so explicitly.
    if (isAdded && /^tests\/.*\.test\.js$/.test(path)) {
      items.push(item(path, "test registration", "pass",
        "no registration needed: node --test discovery and scripts/unit-shards.mjs pick up tests/*.test.js automatically (a duration entry is planner data, refreshed from hosted receipts, not a hand registration)"));
    }
  }

  // --- New open routes vs the base tree: auth tables + probe inventory.
  const baseOpen = new Set((snapshot.openOperationsBase ?? [])
    .filter(op => op.open).map(op => `${op.method} ${op.path}`));
  for (const op of snapshot.openOperationsCurrent ?? []) {
    const key = `${op.method} ${op.path}`;
    if (!op.open || baseOpen.has(key)) continue;
    const file = "docs/openapi.yaml";
    if ((snapshot.routeAuthTableSource ?? "").includes(op.path)) {
      items.push(item(file, "ROUTE-AUTH-TABLE (open route)", "pass", `${key} is named in docs/ROUTE-AUTH-TABLE.md`));
    } else {
      items.push(item(file, "ROUTE-AUTH-TABLE (open route)", "fail", `new open route ${key} is not named in docs/ROUTE-AUTH-TABLE.md; add it there (scripts/open-routes.mjs --check in the contract step enforces this)`));
    }
    if ((snapshot.inviteOnlyChecklistSource ?? "").includes(op.path)) {
      items.push(item(file, "INVITE-ONLY-CHECKLIST (open route)", "pass", `${key} is named in docs/INVITE-ONLY-CHECKLIST.md`));
    } else {
      items.push(item(file, "INVITE-ONLY-CHECKLIST (open route)", "fail", `new open route ${key} is not named in docs/INVITE-ONLY-CHECKLIST.md section 1; add it there (scripts/open-routes.mjs --check in the contract step enforces this)`));
    }
    if ((snapshot.inviteProbesSource ?? "").includes(key)) {
      items.push(item(file, "endpoint-inventory PROBES (open route)", "pass", `${key} has an anonymous probe in tests/invite-only-boundary.test.js (PROBES)`));
    } else {
      items.push(item(file, "endpoint-inventory PROBES (open route)", "fail", `new open route ${key} has no entry in the PROBES inventory in tests/invite-only-boundary.test.js; add a probe stating the expected anonymous response`));
    }
  }

  return items;
}

export function summariseItems(items) {
  return {
    failures: items.filter(i => i.status === "fail"),
    checks: items.filter(i => i.status === "check"),
    passes: items.filter(i => i.status === "pass"),
  };
}

// ---------------------------------------------------------------------------
// Snapshot construction from a real checkout (CLI / verify-pr orchestrator).
// ---------------------------------------------------------------------------

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });
}

export function collectChangedFiles(baseRef) {
  let mergeBase = baseRef;
  try { mergeBase = git(["merge-base", baseRef, "HEAD"]).trim() || baseRef; } catch { /* diff against the ref itself */ }
  const changed = new Map();
  const tokens = git(["diff", "--name-status", "-z", mergeBase]).split("\0").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!/^[A-Z]/.test(status)) continue;
    const path = tokens[++i];
    if (/^[RC]/.test(status)) i++; // rename/copy records carry a second path
    if (path) changed.set(path, status[0]);
  }
  for (const path of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    if (!changed.has(path)) changed.set(path, "A");
  }
  const addedLines = new Map();
  const unified = git(["diff", "-U0", mergeBase]);
  let current = null;
  for (const line of unified.split("\n")) {
    if (line.startsWith("+++ b/")) { current = line.slice(6); addedLines.set(current, ""); continue; }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.set(current, (addedLines.get(current) ?? "") + line.slice(1) + "\n");
    }
  }
  for (const [path, status] of changed) {
    if (status === "A" && !addedLines.has(path) && existsSync(join(root, path))) {
      try { addedLines.set(path, readFileSync(join(root, path), "utf8")); } catch { /* binary or unreadable */ }
    }
  }
  return { mergeBase, changed: [...changed.entries()].map(([path, status]) => ({ path, status })), addedLines };
}

export async function buildSnapshot({ baseRef = "origin/main", files = null } = {}) {
  const { mergeBase, changed, addedLines } = files
    ? { mergeBase: baseRef, changed: files.map(path => ({ path, status: "A" })), addedLines: new Map(files.map(path => [path, existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : ""])) }
    : collectChangedFiles(baseRef);

  const read = path => { try { return readFileSync(join(root, path), "utf8"); } catch { return ""; } };
  const [{ findUntested }, { allowed, publicAssets }, { importClosure }, { openapiOperations }] = await Promise.all([
    import("./untested-modules-lint.mjs"),
    import("./runtime-package.mjs"),
    import("./runtime-import-closure.mjs"),
    import("./open-routes.mjs"),
  ]);

  let untested = new Set();
  try { untested = new Set(findUntested(join(root, "server"), join(root, "tests")).untested); } catch { /* surfaced by the untested step itself */ }

  const packagedClosures = new Map();
  for (const entry of ["server.mjs", "scripts/run-codex-room.mjs", "cloudflare/room.mjs"]) {
    try { packagedClosures.set(entry, new Set([entry, ...importClosure(entry, root)])); } catch { /* entry absent */ }
  }

  const importedByPublicAssets = new Set();
  for (const asset of publicAssets) {
    const source = read(asset);
    const dir = asset.split("/").slice(0, -1).join("/");
    for (const m of source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const parts = (dir ? dir.split("/") : []).concat(m[1].split("/"));
      const out = [];
      for (const part of parts) { if (part === "..") out.pop(); else if (part !== ".") out.push(part); }
      importedByPublicAssets.add(out.join("/"));
    }
  }

  const ops = text => openapiOperations(text).map(op => ({
    method: op.method, path: op.path, open: Array.isArray(op.security) && op.security.length === 0,
  }));
  let baseOps = [];
  try { baseOps = ops(git(["show", `${mergeBase}:docs/openapi.yaml`])); } catch { /* no base spec: every open route counts as new */ }

  const fileContents = new Map();
  for (const { path } of changed) {
    if (path.startsWith("scripts/") && existsSync(join(root, path))) fileContents.set(path, read(path));
  }

  return {
    changed, addedLines, fileContents,
    untestedServerModules: untested,
    packagedClosures,
    runtimeAllowed: allowed,
    publicAssets: [...publicAssets],
    buildAssetsSource: read("cloudflare/build-assets.mjs"),
    importedByPublicAssets,
    writerFenceSource: read("server/writer-fence.mjs"),
    purgeRegistrySource: read("server/purge-registry.mjs"),
    packageJsonSource: read("package.json"),
    routeAuthTableSource: read("docs/ROUTE-AUTH-TABLE.md"),
    inviteOnlyChecklistSource: read("docs/INVITE-ONLY-CHECKLIST.md"),
    inviteProbesSource: read("tests/invite-only-boundary.test.js"),
    openOperationsCurrent: ops(read("docs/openapi.yaml")),
    openOperationsBase: baseOps,
  };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";
  const filesIdx = args.indexOf("--files");
  const files = filesIdx >= 0 ? args[filesIdx + 1].split(",").filter(Boolean) : null;
  const snapshot = await buildSnapshot({ baseRef, files });
  const items = buildRegistrationItems(snapshot);
  const { failures, checks, passes } = summariseItems(items);
  console.log(`registration checklist: ${snapshot.changed.length} changed file(s) vs ${baseRef}`);
  if (items.length === 0) console.log("  (no registration-bearing file classes in this diff)");
  for (const entry of items) {
    const tag = entry.status === "fail" ? "FAIL " : entry.status === "pass" ? "PASS " : "CHECK";
    console.log(`  [${tag}] ${entry.file} — ${entry.rule}: ${entry.detail}`);
  }
  console.log(`registration checklist: ${failures.length} failure(s), ${checks.length} check item(s), ${passes.length} pass(es)`);
  if (failures.length > 0) process.exit(1);
}
