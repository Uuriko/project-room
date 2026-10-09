#!/usr/bin/env node
/**
 * partition-check.mjs — pre-wave partition overlap gate.
 *
 * Verifies that a set of wave partitions (workers / coordinators / lanes) are
 * disjoint across four axes before a wave launches:
 *   (a) file/dir overlap, incl. dir-prefix containment
 *       (dir "server/" overlaps file "server/http.mjs")
 *   (b) branch-name overlap (exact match)
 *   (c) claim-id namespace overlap (exact match, or same namespace after
 *       stripping a trailing worker/index suffix like "-03" or "/w2")
 *   (d) worktree path overlap (same path, or one contains the other)
 *
 * Input: a JSON file describing the partitions:
 *   {
 *     "partitions": [
 *       { "name": "wave500-bughunt",
 *         "worktree": "/home/hatch/workspace/pr-wave500-bughunt",
 *         "branches": ["wave500/bughunt"],
 *         "claimIds": ["wave500-bughunt-01", "wave500-bughunt-02"],
 *         "dirs": ["tests/", "server/"],
 *         "files": ["scripts/bughunt.mjs"] }
 *     ]
 *   }
 *
 * Usage:
 *   node scripts/partition-check.mjs partitions.json        # human report
 *   node scripts/partition-check.mjs --json partitions.json # machine report
 *
 * Exit codes: 0 = PASS (no overlaps), 1 = FAIL (overlaps found),
 *             2 = usage / input error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------- helpers

const normPath = (p) =>
  String(p)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

// Two repo-relative paths overlap when they are equal or one contains the
// other as a directory prefix: dir "server/" overlaps "server/http.mjs".
const pathsOverlap = (a, b) => {
  a = normPath(a);
  b = normPath(b);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
};

const absNorm = (p) => normPath(resolve(String(p).trim()));

// Two worktrees overlap when they are the same directory or one nests in
// the other (nested worktrees share the same .git working area).
const worktreesOverlap = (a, b) => {
  a = absNorm(a);
  b = absNorm(b);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
};

// Claim-id namespace: strip a trailing worker/index segment so that
// "wave500-claim-scale-01" and "wave500-claim-scale-02" share the namespace
// "wave500-claim-scale", which is what the claim registry collides on.
const claimNamespace = (id) => {
  const s = String(id).trim();
  return s.replace(/([/-])(w?\d+|[a-z]\d*)$/i, (m, sep) =>
    /^\d+$/.test(m.slice(1)) || /^w\d+$/i.test(m.slice(1)) ? "" : m
  );
};

const sameNamespace = (a, b) => {
  a = String(a).trim();
  b = String(b).trim();
  return a === b || claimNamespace(a) === claimNamespace(b);
};

// ---------------------------------------------------------------- core

function checkPartitions(partitions) {
  const overlaps = [];
  const seen = new Set();
  const push = (kind, aName, bName, detail) => {
    const key = `${kind}\0${[aName, bName].sort().join("\0")}\0${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    overlaps.push({ kind, a: aName, b: bName, detail });
  };

  for (let i = 0; i < partitions.length; i++) {
    for (let j = i + 1; j < partitions.length; j++) {
      const A = partitions[i];
      const B = partitions[j];

      // (a) file/dir overlap
      const aPaths = [...(A.dirs ?? []), ...(A.files ?? [])].map(normPath);
      const bPaths = [...(B.dirs ?? []), ...(B.files ?? [])].map(normPath);
      for (const pa of aPaths)
        for (const pb of bPaths)
          if (pathsOverlap(pa, pb))
            push("file/dir", A.name, B.name, `"${pa}" ↔ "${pb}"`);

      // (b) branch-name overlap
      for (const ba of (A.branches ?? []).map((s) => String(s).trim()))
        for (const bb of (B.branches ?? []).map((s) => String(s).trim()))
          if (ba && ba === bb) push("branch", A.name, B.name, `"${ba}"`);

      // (c) claim-id namespace overlap
      for (const ca of (A.claimIds ?? []).map((s) => String(s).trim()))
        for (const cb of (B.claimIds ?? []).map((s) => String(s).trim()))
          if (ca && cb && sameNamespace(ca, cb))
            push(
              "claim-id",
              A.name,
              B.name,
              ca === cb
                ? `identical claim id "${ca}"`
                : `shared namespace "${claimNamespace(ca)}" ("${ca}" ↔ "${cb}")`
            );

      // (d) worktree path overlap
      if (A.worktree && B.worktree && worktreesOverlap(A.worktree, B.worktree))
        push(
          "worktree",
          A.name,
          B.name,
          `"${absNorm(A.worktree)}" ↔ "${absNorm(B.worktree)}"`
        );
    }
  }
  return overlaps;
}

// ---------------------------------------------------------------- cli

function usage() {
  console.error(
    "usage: node scripts/partition-check.mjs [--json] <partitions.json>\n" +
      "  exits 0 on PASS, 1 on FAIL (overlaps), 2 on usage/input error"
  );
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const file = args.filter((a) => a !== "--json")[0];

if (!file) {
  usage();
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`input error: cannot read/parse ${file}: ${e.message}`);
  process.exit(2);
}

const partitions = doc.partitions ?? doc;
if (!Array.isArray(partitions) || partitions.length < 2) {
  console.error(
    "input error: need a JSON object with a 'partitions' array of 2+ entries"
  );
  process.exit(2);
}

for (const p of partitions) {
  if (!p || typeof p.name !== "string" || !p.name.trim()) {
    console.error("input error: every partition needs a non-empty 'name'");
    process.exit(2);
  }
}

const overlaps = checkPartitions(partitions);

if (jsonOut) {
  console.log(
    JSON.stringify(
      { verdict: overlaps.length ? "FAIL" : "PASS", overlaps },
      null,
      2
    )
  );
} else if (!overlaps.length) {
  console.log(`PASS — ${partitions.length} partitions, zero overlaps`);
} else {
  console.log(
    `FAIL — ${overlaps.length} overlap(s) across ${partitions.length} partitions:`
  );
  for (const o of overlaps)
    console.log(`  [${o.kind}] ${o.a} × ${o.b}: ${o.detail}`);
}

process.exit(overlaps.length ? 1 : 0);
