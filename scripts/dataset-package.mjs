#!/usr/bin/env node
// Dataset package CLI — the extract-pipeline seam (data programme W4).
//
// Stage 1 (assemble) is W2's scripts/extract-episodes.mjs: it reads a
// trailer-verified snapshot and emits work-episodes NDJSON. THIS script is
// stages 2–6: U5 visibility filter -> bright-line classification ->
// anonymise (Tier R rows / Tier T text) -> package -> quality gates.
//
//   node scripts/dataset-package.mjs \
//     --episodes episodes.ndjson \        (W2 assembler output, one episode per line)
//     --snapshot snapshot.ndjson \        (room-export NDJSON; supplies public_unpublish,
//                                          room_directory_settings, room_public_receipts_setting,
//                                          accounts, agent_identities, bounty_journal)
//     --rooms rooms.json \                ({ roomId: { privateRoom, enterpriseNda, sensitive,
//                                          memberCount, surfaceMix } } — operator extract metadata)
//     --handles handles.json \            ({ identityId: [githubHandle, ...] }, optional)
//     --key-file extract-key.txt \        (per-package pseudonym key; NEVER an argv value)
//     --package-id pkg-2026-10-18-a \
//     --class external|internal \
//     --tiers R,T \
//     --public-corpus corpus/ \           (dir of .txt/.md public texts for the uniqueness gate)
//     --manual-review review.json \       ({ reviewer, sampledRecordIds, verdict }) — required
//                                          for external Tier T (GQ-3's human gate; the ids to
//                                          cover are the R9 risk-tiered sample in the manifest)
//     --audit-rates high=1,medium=0.25,standard=0.02 \   (R9 per-stratum inclusion rates)
//     --out package-dir/
//
// Exit 0 = package built, all blocking gates pass. Exit 1 = a blocking gate
// failed: files are still written and the manifest says FAILED — inspect,
// never ship. Nothing here transmits anything anywhere.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDatasetPackage,
  peopleFromSnapshotTables,
  visibilityFromSnapshotTables,
} from "../server/dataset-package.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function fail(msg) {
  console.error(`dataset-package: ${msg}`);
  process.exit(2);
}

const episodesPath = arg("episodes") ?? fail("--episodes is required");
const keyFile = arg("key-file") ?? fail("--key-file is required");
const packageId = arg("package-id") ?? fail("--package-id is required");
const outDir = arg("out") ?? fail("--out is required");
const packageClass = arg("class", "external");
const tiers = (arg("tiers", "R") ?? "R").split(",").map(s => s.trim()).filter(Boolean);

const episodes = readFileSync(episodesPath, "utf8")
  .split("\n").filter(Boolean).map(line => JSON.parse(line));

const tables = {};
const snapshotPath = arg("snapshot");
if (snapshotPath) {
  for (const line of readFileSync(snapshotPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const table = row.__table ?? row.table;
    if (!table) continue;
    (tables[table] ??= []).push(row);
  }
}
const rooms = arg("rooms") ? JSON.parse(readFileSync(arg("rooms"), "utf8")) : {};
const handles = arg("handles") ? JSON.parse(readFileSync(arg("handles"), "utf8")) : {};
const manualReview = arg("manual-review")
  ? JSON.parse(readFileSync(arg("manual-review"), "utf8"))
  : null;

const publicCorpusTexts = [];
const corpusDir = arg("public-corpus");
if (corpusDir) {
  for (const name of readdirSync(corpusDir)) {
    if (/\.(txt|md)$/i.test(name)) publicCorpusTexts.push(readFileSync(join(corpusDir, name), "utf8"));
  }
}

const auditRates = (() => {
  const raw = arg("audit-rates");
  if (!raw) return null;
  const rates = {};
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=");
    rates[k.trim()] = Number(v);
  }
  return rates;
})();

const journal = tables.bounty_journal ?? [];
const result = buildDatasetPackage({
  episodes,
  rooms,
  people: peopleFromSnapshotTables(tables, handles),
  visibility: visibilityFromSnapshotTables(tables),
  journalEntries: journal.length ? journal : null,
  key: readFileSync(keyFile, "utf8").trim(),
  packageId,
  packageClass,
  tiers,
  manualReview,
  auditRates,
  publicCorpusTexts,
  builtAt: new Date().toISOString(),
  actor: arg("actor"),
  snapshotHash: arg("snapshot-hash"),
  prodRevision: arg("prod-revision"),
});

mkdirSync(outDir, { recursive: true });
for (const [name, content] of result.files) writeFileSync(join(outDir, name), content);

for (const g of result.gates) {
  console.log(`${g.id} ${g.name}: ${g.status}${g.blocking ? "" : " (advisory)"} — ${g.detail}`);
}
console.log(`package ${packageId}: ${result.manifest.status} -> ${outDir}`);
process.exit(result.manifest.status === "FAILED" ? 1 : 0);
