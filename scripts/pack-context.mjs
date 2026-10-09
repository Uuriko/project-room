#!/usr/bin/env node
/**
 * pack-context.mjs — shared-context packer for swarm-wave worker briefs.
 *
 * Problem: every worker brief in a coordination wave repeats the same standing
 * context (one-shot semantics, worktree rules, claims discipline, push rules,
 * safety). At N workers that is the same kilobytes x N.
 *
 * This tool factors the repeated context into a versioned, checksummed pack
 * (context-packs/<name>-pack.<version>.md) and reduces each worker brief to a
 * per-worker template: a small contextRef pointer + slot declarations + the
 * worker-specific delta only.
 *
 * Commands:
 *   split       --in <brief.md> --name <pack-name> --version v1|v2 --out-dir <dir>
 *               Split one full worker brief into a shared pack + per-worker template.
 *               The brief marks regions with <!-- SHARED --> / <!-- /SHARED --> and
 *               <!-- PER-WORKER --> / <!-- /PER-WORKER -->. Worker-specific parts
 *               use {{SLOT_NAME}} placeholders.
 *   extract     --briefs <dir|-> --name <pack-name> --version <v> --out-dir <dir>
 *               Multi-brief mode: paragraphs common to >= --min-share of briefs
 *               become the pack; each brief's residual becomes its template.
 *   validate    --brief <brief.md|-> --pack <pack.md> [--strict]
 *               Validate a worker brief (full or template) against a pack.
 *   measure     --briefs <dir|-> --pack <pack.md> [--json]
 *               Report bytes + estimated tokens: full briefs vs packed form.
 *   list        [--dir context-packs]
 *               List available packs with version + checksum.
 *   gen-briefs  --out <dir> --workers <n> --pack <pack.md> [--seed <n>]
 *               Generate n deterministic realistic full worker briefs for measurement.
 *
 * Token estimate: ~1 token per 4 chars (rough, documented; good for comparisons).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";

const TOKEN_CHARS = 4;
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const CONTEXT_REF_RE = /^contextRef:\s*([a-z0-9-]+)@v(\d+):([0-9a-f]{12,64})\s*$/m;
const SLOT_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function tok(bytes) {
  return Math.ceil(bytes / TOKEN_CHARS);
}
function readInput(p) {
  return p === "-" ? readFileSync(0, "utf8") : readFileSync(p, "utf8");
}
function fail(msg) {
  console.error("pack-context: error: " + msg);
  process.exit(1);
}
function norm(s) {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
function paragraphs(s) {
  return norm(s).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/* ---------------- pack file ---------------- */

function parsePack(text, path) {
  const m = text.match(FRONT_MATTER_RE);
  if (!m) fail(`pack ${path}: missing YAML front matter (--- ... ---)`);
  const fm = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  // multi-line list support for `forbidden:` (dash items on following lines)
  const forb = [];
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^forbidden:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]); j++) {
        forb.push(lines[j].replace(/^\s*-\s*/, "").replace(/^"|"$/g, ""));
      }
    }
  }
  if (forb.length) fm.forbidden = forb;
  const body = text.slice(m[0].length);
  return { fm, body, raw: text };
}

function verifyPackIntegrity(pack, path) {
  const errors = [];
  if (!pack.fm.pack) errors.push("front matter missing `pack` name");
  if (!pack.fm.version) errors.push("front matter missing `version`");
  if (!pack.fm.sha256) {
    errors.push("front matter missing `sha256` checksum");
  } else if (sha256(pack.body) !== pack.fm.sha256) {
    errors.push(
      `checksum mismatch: front matter says ${pack.fm.sha256.slice(0, 12)}…, ` +
        `body hashes to ${sha256(pack.body).slice(0, 12)}… (pack file was edited after publishing — publish a new version instead)`
    );
  }
  return errors;
}

function packFileName(dir, name, version) {
  return join(dir, `${name}-pack.${version}.md`);
}

/* ---------------- split ---------------- */

function splitBrief(text) {
  const sharedRe = /<!--\s*SHARED\s*-->([\s\S]*?)<!--\s*\/SHARED\s*-->/;
  const workerRe = /<!--\s*PER-WORKER\s*-->([\s\S]*?)<!--\s*\/PER-WORKER\s*-->/;
  const sm = text.match(sharedRe);
  const wm = text.match(workerRe);
  if (!sm || !wm) {
    fail(
      "split: brief needs <!-- SHARED --> … <!-- /SHARED --> and " +
        "<!-- PER-WORKER --> … <!-- /PER-WORKER --> markers (or use `extract` for markerless multi-brief mode)"
    );
  }
  return { shared: sm[1].trim(), worker: wm[1].trim() };
}

function slotsUsed(templateText) {
  const out = new Set();
  let m;
  SLOT_RE.lastIndex = 0;
  while ((m = SLOT_RE.exec(templateText))) out.add(m[1]);
  return [...out].sort();
}

function renderPackFile(name, version, sharedBody, opts = {}) {
  const fm = [
    "---",
    `pack: ${name}`,
    `version: ${version}`,
    `sha256: ${sha256(sharedBody + "\n")}`,
    `created: ${opts.created || new Date().toISOString().slice(0, 10)}`,
    `status: ${opts.status || "stable"}`,
    `supersedes: ${opts.supersedes || "none"}`,
  ];
  if (opts.forbidden && opts.forbidden.length) {
    fm.push("forbidden:");
    for (const f of opts.forbidden) fm.push(`  - "${f}"`);
  }
  fm.push("---", "");
  return fm.join("\n") + sharedBody + "\n";
}

function renderTemplate(name, version, checksum, workerBody) {
  const slots = slotsUsed(workerBody);
  const slotDocs = slots.map((s) => `  ${s}: "<describe this worker's value>"`).join("\n");
  return (
    `---\n` +
    `worker: {{WORKER_ID}}\n` +
    `contextRef: ${name}@${version}:${checksum.slice(0, 12)}\n` +
    `slots:\n${slotDocs}\n` +
    `---\n\n` +
    workerBody.trim() +
    `\n`
  );
}

/* ---------------- extract (multi-brief) ---------------- */

function extractPack(briefTexts, minShare) {
  const paraDocs = briefTexts.map(paragraphs);
  const df = new Map(); // normalized paragraph -> doc count
  const firstSeen = new Map();
  paraDocs.forEach((paras, di) => {
    const seen = new Set();
    paras.forEach((p, pi) => {
      const key = p.replace(/\s+/g, " ");
      if (!seen.has(key)) {
        seen.add(key);
        df.set(key, (df.get(key) || 0) + 1);
        if (!firstSeen.has(key)) firstSeen.set(key, { di, pi, text: p });
      }
    });
  });
  const n = briefTexts.length;
  const sharedKeys = [...df.entries()]
    .filter(([, c]) => c / n >= minShare)
    .map(([k]) => k)
    .sort((a, b) => {
      const fa = firstSeen.get(a),
        fb = firstSeen.get(b);
      return fa.di - fb.di || fa.pi - fb.pi;
    });
  const sharedSet = new Set(sharedKeys);
  const sharedBody = sharedKeys.map((k) => firstSeen.get(k).text).join("\n\n");
  const residuals = paraDocs.map((paras) =>
    paras.filter((p) => !sharedSet.has(p.replace(/\s+/g, " "))).join("\n\n")
  );
  return { sharedBody, residuals, coverage: sharedKeys.length };
}

/* ---------------- validate ---------------- */

function validateBrief(briefText, pack, path, strict) {
  const errors = [];
  const warnings = [];
  const integ = verifyPackIntegrity(pack, path);
  errors.push(...integ);

  const ref = briefText.match(CONTEXT_REF_RE);
  const packName = pack.fm.pack || "?";
  const packVersion = (pack.fm.version || "?").replace(/^v/, "");
  const packSum = (pack.fm.sha256 || "").slice(0, 12);

  if (ref) {
    // template mode: brief references the pack instead of inlining it
    const [, rName, rVer, rSum] = ref;
    if (rName !== packName) errors.push(`contextRef pack name "${rName}" != pack "${packName}"`);
    if (rVer !== packVersion) errors.push(`contextRef version v${rVer} != pack v${packVersion} (re-point the template or publish a new pack version)`);
    if (!pack.fm.sha256.startsWith(rSum) && rSum !== packSum)
      errors.push(`contextRef checksum ${rSum} does not match pack ${packSum}…`);
    // slots must be declared
    const declared = new Set();
    const slotBlock = briefText.match(/^slots:\s*\n((?:[ \t]+[A-Z0-9_]+:.*\n?)+)/m);
    if (slotBlock) {
      for (const l of slotBlock[1].split("\n")) {
        const mm = l.match(/^\s*([A-Z][A-Z0-9_]*):/);
        if (mm) declared.add(mm[1]);
      }
    }
    const used = slotsUsed(briefText);
    for (const s of used)
      if (!declared.has(s)) (strict ? errors : warnings).push(`slot {{${s}}} used but not declared in slots:`);
    for (const s of declared)
      if (!used.includes(s)) warnings.push(`slot {{${s}}} declared but never used`);
    if (used.length === 0) warnings.push("template declares a contextRef but uses no {{SLOTS}} — is the delta missing?");
  } else {
    // full-brief mode: the shared context must be present verbatim
    const reqParas = paragraphs(pack.body).filter((p) => /\[REQ\]/.test(p));
    const checkParas = reqParas.length ? reqParas : paragraphs(pack.body);
    const bnorm = norm(briefText).replace(/\[REQ\]/g, "");
    let missing = 0;
    for (const p of checkParas) {
      const key = p.replace(/\s+/g, " ").replace(/\[REQ\]/g, "").replace(/\s+/g, " ").trim();
      if (key.length < 40) continue;
      if (!bnorm.replace(/\s+/g, " ").includes(key.slice(0, 120))) {
        missing++;
        (strict ? errors : warnings).push(`shared rule not found in brief: "${key.slice(0, 80)}…"`);
      }
    }
    if (missing === 0) warnings.push("note: full brief contains all pack rules — consider shipping the packed template instead");
  }

  // drift scan: brief must not assert the opposite of a pack rule
  const forbidden = Array.isArray(pack.fm.forbidden) ? pack.fm.forbidden : [];
  for (const f of forbidden) {
    const fl = String(f).toLowerCase();
    if (fl && briefText.toLowerCase().includes(fl)) {
      const negated = new RegExp(`(never|not|don't|do not|n't)\\s+[^\\n]{0,40}${fl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(briefText);
      if (!negated) (strict ? errors : warnings).push(`possible rule drift: brief contains forbidden phrase "${f}"`);
    }
  }
  return { errors, warnings };
}

/* ---------------- measure ---------------- */

function measureBriefs(briefTexts, pack) {
  const packBytes = Buffer.byteLength(pack.body, "utf8");
  const packParas = paragraphs(pack.body).map((p) => p.replace(/\s+/g, " "));
  const header = `---\nworker: {{WORKER_ID}}\ncontextRef: ${pack.fm.pack}@${pack.fm.version}:${(pack.fm.sha256 || "").slice(0, 12)}\n---\n\n`;
  const headerBytes = Buffer.byteLength(header, "utf8");
  let fullBytes = 0,
    packedBytes = packBytes,
    minCover = 1,
    totalParas = 0,
    matchedParas = 0;
  for (const b of briefTexts) {
    const bb = Buffer.byteLength(b, "utf8");
    fullBytes += bb;
    const bflat = norm(b).replace(/\s+/g, " ");
    let matchedBytes = 0;
    for (const p of packParas) {
      totalParas++;
      if (p.length > 40 && bflat.includes(p.slice(0, 200))) {
        matchedBytes += Buffer.byteLength(p, "utf8");
        matchedParas++;
      }
    }
    const cover = packBytes ? matchedBytes / packBytes : 1;
    if (cover < minCover) minCover = cover;
    packedBytes += Math.max(0, bb - matchedBytes) + headerBytes;
  }
  const n = briefTexts.length;
  const saved = fullBytes - packedBytes;
  return {
    workers: n,
    packBytes,
    packTokens: tok(packBytes),
    fullBytes,
    fullTokens: tok(fullBytes),
    packedBytes,
    packedTokens: tok(packedBytes),
    savedBytes: saved,
    savedTokens: tok(fullBytes) - tok(packedBytes),
    savedBytesPerWorker: n ? Math.round(saved / n) : 0,
    savedPct: fullBytes ? +(100 * (saved / fullBytes)).toFixed(1) : 0,
    minPackCoverage: +minCover.toFixed(3),
    matchedParagraphs: `${matchedParas}/${totalParas}`,
  };
}

/* ---------------- CLI ---------------- */

function getopt(argv) {
  const opts = {},
    rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      opts[k] = v;
    } else rest.push(a);
  }
  return { opts, rest };
}

function cmdSplit({ opts }) {
  const inPath = opts.in || fail("--in <brief.md> required");
  const name = opts.name || fail("--name <pack-name> required");
  const version = (opts.version || "v1").replace(/^v/, "");
  const outDir = opts.outDir || opts["out-dir"] || "context-packs";
  const text = readInput(inPath);
  const { shared, worker } = splitBrief(text);
  const forbidden = (opts.forbidden || "push to main,git push origin main,skip the claims board,invent time estimates,edit MEMORY.md,spawn subagents")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sharedBody = shared;
  const packText = renderPackFile(name, `v${version}`, sharedBody, { forbidden });
  mkdirSync(outDir, { recursive: true });
  const packPath = packFileName(outDir, name, `v${version}`);
  if (existsSync(packPath) && opts.force !== true && opts.force !== "true")
    fail(`pack exists: ${packPath} (packs are immutable — bump --version or pass --force)`);
  writeFileSync(packPath, packText);
  const checksum = sha256(sharedBody + "\n");
  const template = renderTemplate(name, `v${version}`, checksum, worker);
  if (opts.templateOut || opts["template-out"]) writeFileSync(opts.templateOut || opts["template-out"], template);
  else process.stdout.write(template);
  console.error(`wrote ${packPath} (${Buffer.byteLength(sharedBody, "utf8")} bytes shared, sha256 ${checksum.slice(0, 12)}…)`);
  console.error(`template: ${slotsUsed(worker).length} slots (${slotsUsed(worker).join(", ") || "none"})`);
}

function cmdExtract({ opts }) {
  const src = opts.briefs || fail("--briefs <dir|-> required");
  const name = opts.name || fail("--name <pack-name> required");
  const version = (opts.version || "v1").replace(/^v/, "");
  const outDir = opts.outDir || opts["out-dir"] || "context-packs";
  const minShare = parseFloat(opts.minShare || opts["min-share"] || "0.8");
  let texts;
  if (src === "-") {
    texts = readFileSync(0, "utf8").split("\n===BRIEF===\n").filter((t) => t.trim());
  } else {
    texts = readdirSync(src)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readFileSync(join(src, f), "utf8"));
  }
  if (!texts.length) fail("no briefs found");
  const { sharedBody, residuals } = extractPack(texts, minShare);
  const packText = renderPackFile(name, `v${version}`, sharedBody, {});
  mkdirSync(outDir, { recursive: true });
  const packPath = packFileName(outDir, name, `v${version}`);
  if (existsSync(packPath) && opts.force !== true && opts.force !== "true") fail(`pack exists: ${packPath} (packs are immutable — bump --version)`);
  writeFileSync(packPath, packText);
  const checksum = sha256(sharedBody + "\n");
  const tplDir = opts.templatesOut || opts["templates-out"];
  if (tplDir) {
    mkdirSync(tplDir, { recursive: true });
    residuals.forEach((r, i) => writeFileSync(join(tplDir, `worker-${i + 1}.template.md`), renderTemplate(name, `v${version}`, checksum, r)));
    console.error(`wrote ${residuals.length} templates to ${tplDir}/`);
  }
  console.error(`wrote ${packPath} (${Buffer.byteLength(sharedBody, "utf8")} bytes shared across ${texts.length} briefs, min-share ${minShare})`);
}

function cmdValidate({ opts }) {
  const briefPath = opts.brief || fail("--brief <brief.md|-> required");
  const packPath = opts.pack || fail("--pack <pack.md> required");
  const strict = opts.strict === true || opts.strict === "true";
  const packText = readFileSync(packPath, "utf8");
  const pack = parsePack(packText, packPath);
  const briefText = readInput(briefPath);
  const { errors, warnings } = validateBrief(briefText, pack, packPath, strict);
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`VALIDATE FAIL: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`VALIDATE OK: brief conforms to ${pack.fm.pack}@${pack.fm.version} (${warnings.length} warning(s))`);
}

function readBriefs(src) {
  if (src === "-") return readFileSync(0, "utf8").split("\n===BRIEF===\n").filter((t) => t.trim());
  return readdirSync(src)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readFileSync(join(src, f), "utf8"));
}

function cmdMeasure({ opts }) {
  const src = opts.briefs || fail("--briefs <dir|-> required");
  const packPath = opts.pack || fail("--pack <pack.md> required");
  const pack = parsePack(readFileSync(packPath, "utf8"), packPath);
  const integ = verifyPackIntegrity(pack, packPath);
  if (integ.length) fail("pack integrity: " + integ.join("; "));
  const briefs = readBriefs(src);
  if (!briefs.length) fail("no briefs found");
  const r = measureBriefs(briefs, pack);
  if (opts.json === true || opts.json === "true") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`pack: ${pack.fm.pack}@${pack.fm.version}  sha256 ${pack.fm.sha256.slice(0, 12)}…`);
  console.log(`workers: ${r.workers}`);
  console.log(`pack coverage (min fraction of pack found per brief): ${r.minPackCoverage}  (${r.matchedParagraphs} paragraphs)`);
  console.log("");
  console.log(`                          bytes        tokens(~)`);
  console.log(`  full briefs   ${String(r.fullBytes).padStart(12)}  ${String(r.fullTokens).padStart(12)}`);
  console.log(`  packed        ${String(r.packedBytes).padStart(12)}  ${String(r.packedTokens).padStart(12)}`);
  console.log(`  saved         ${String(r.savedBytes).padStart(12)}  ${String(r.savedTokens).padStart(12)}  (${r.savedPct}%)`);
  console.log("");
  console.log(`saved per worker: ${r.savedBytesPerWorker} bytes (~${tok(r.savedBytesPerWorker)} tokens)`);
}

function cmdList({ opts }) {
  const dir = opts.dir || "context-packs";
  if (!existsSync(dir)) fail(`no such dir: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) {
    console.log("(no packs)");
    return;
  }
  for (const f of files) {
    const p = join(dir, f);
    try {
      const pack = parsePack(readFileSync(p, "utf8"), p);
      const integ = verifyPackIntegrity(pack, p);
      const status = integ.length ? "CORRUPT" : "ok";
      console.log(`${f}  ${pack.fm.pack}@${pack.fm.version}  sha256 ${(pack.fm.sha256 || "?").slice(0, 12)}…  supersedes=${pack.fm.supersedes || "none"}  [${status}]`);
    } catch (e) {
      console.log(`${f}  UNREADABLE: ${e.message}`);
    }
  }
}

// Deterministic synthetic brief generator for measurement. Shared context is the
// pack body verbatim; each worker gets a realistic unique delta.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DELTA_TASKS = [
  ["receipt schema", "scripts/receipt-schema.mjs", "design + prototype the v1 receipt JSON schema workers post on completion; include worker id, done-condition evidence, byte counts."],
  ["partition planner", "scripts/partition-plan.mjs", "given a work graph, partition it into k balanced slices minimizing cross-slice file overlap; emit JSON plan."],
  ["overhead meter", "scripts/meter-overhead.mjs", "instrument coordinator turns: measure wall-clock + token cost per spawn, fan-out, and receipt round."],
  ["digest builder", "scripts/build-digest.mjs", "build the coordinator digest: roll up N worker receipts into one status page with failures surfaced first."],
  ["ask batcher", "scripts/ask-batch.mjs", "batch ASK-round questions from workers into one coordinator turn; dedupe identical asks."],
  ["e2e trial", "scripts/e2e-trial.mjs", "run a 25-worker dry-run trial of the whole dispatch path with fake workers; assert receipts == workers."],
  ["chatter cost", "scripts/chatter-cost.mjs", "model room-chatter cost: bytes per coordination message x message count for N=500."],
  ["context packer", "scripts/pack-context.mjs", "build the shared-context packer prototype (this tool)."],
  ["batch dispatch", "scripts/batch-dispatch.mjs", "validate batch manifests and emit the factored envelope with savings report."],
  ["claim ledger", "scripts/claim-ledger.mjs", "append-only claim ledger with first-claim-wins enforcement and collision reports."],
  ["stale sweep", "scripts/stale-sweep.mjs", "detect claims older than TTL with no heartbeat and release them."],
  ["heartbeat", "scripts/heartbeat.mjs", "worker heartbeat emitter; coordinator sidecar aggregates liveness."],
  ["retry planner", "scripts/retry-plan.mjs", "decide retry vs re-dispatch for failed workers given failure class."],
  ["cost report", "docs/COST-REPORT.md", "write the coordination-overhead cost report with measured numbers."],
  ["playbook", "docs/SWARM-PLAYBOOK.md", "write the swarm coordination playbook for future waves."],
  ["spec audit", "docs/SPEC-AUDIT.md", "audit the dispatch specs for contradictions; file findings."],
  ["queue depth", "scripts/queue-depth.mjs", "estimate merge-queue depth cost under N parallel workers."],
  ["token ledger", "scripts/token-ledger.mjs", "track per-worker token spend against a wave budget; alert at 80%."],
  ["receipt verify", "scripts/receipt-verify.mjs", "verify worker receipts against done-conditions; flag fakes."],
  ["fanout sim", "scripts/fanout-sim.mjs", "simulate one-turn fan-out latency distribution for N=500."],
  ["brief linter", "scripts/brief-lint.mjs", "lint worker briefs for missing done-conditions and unbounded scope."],
  ["slot filler", "scripts/slot-fill.mjs", "fill per-worker templates from a worker roster CSV; emit ready briefs."],
  ["version bump", "scripts/pack-bump.mjs", "bump a context pack v1 -> v2 carrying forward unchanged rules."],
  ["drift watch", "scripts/drift-watch.mjs", "watch briefs for rule drift against the pinned pack version."],
  ["savings rollup", "docs/SAVINGS-ROLLUP.md", "roll up measured savings from all 17 workers into one table."],
];
function genBrief(workerId, task, packBody, rnd) {
  const [title, file, desc] = task;
  const extra = rnd() < 0.5 ? `\nEdge cases to cover: ${["empty input", "duplicate ids", "checksum mismatch", "N=1", "N=500"][Math.floor(rnd() * 5)]}.\n` : "";
  const delta =
    `WORKER ${workerId}/17 — ${title}.\n\n` +
    `YOUR BRIEF (bounded):\n` +
    `1. Read the live work-claims board before starting. Don't duplicate siblings or other lanes. First-claim-wins.\n` +
    `2. Work in ~/workspace/pr-wave500-coord-cost (branch wave500/coord-cost — verify before committing). TMPDIR=~/workspace/pr-wave500-coord-cost/.tmp. scripts/ + docs/ only.\n` +
    `3. Build ${file}: ${desc}${extra}\n` +
    `Done: ${file} committed + pushed to origin wave500/coord-cost. Report back: bytes saved per worker.\n`;
  return `<!-- SHARED -->\n${packBody}\n<!-- /SHARED -->\n\n<!-- PER-WORKER -->\n${delta}<!-- /PER-WORKER -->\n`;
}
function cmdGenBriefs({ opts }) {
  const out = opts.out || fail("--out <dir> required");
  const n = parseInt(opts.workers || "25", 10);
  const packPath = opts.pack || fail("--pack <pack.md> required");
  const seed = parseInt(opts.seed || "42", 10);
  const pack = parsePack(readFileSync(packPath, "utf8"), packPath);
  const integ = verifyPackIntegrity(pack, packPath);
  if (integ.length) fail("pack integrity: " + integ.join("; "));
  const rnd = mulberry32(seed);
  mkdirSync(out, { recursive: true });
  for (let i = 0; i < n; i++) {
    const task = DELTA_TASKS[i % DELTA_TASKS.length];
    writeFileSync(join(out, `brief-${String(i + 1).padStart(2, "0")}.md`), genBrief(i + 1, task, pack.body.trim(), rnd));
  }
  console.error(`wrote ${n} briefs to ${out}/ (seed ${seed})`);
}

const CMDS = { split: cmdSplit, extract: cmdExtract, validate: cmdValidate, measure: cmdMeasure, list: cmdList, "gen-briefs": cmdGenBriefs };

function usage() {
  console.error(`pack-context.mjs — shared-context packer for swarm-wave worker briefs

usage: node scripts/pack-context.mjs <command> [options]

  split      --in <brief.md> --name <pack> --version <v> --out-dir <dir> [--template-out <f>]
  extract    --briefs <dir|-> --name <pack> --version <v> --out-dir <dir> [--min-share 0.8] [--templates-out <dir>]
  validate   --brief <brief.md|-> --pack <pack.md> [--strict]
  measure    --briefs <dir|-> --pack <pack.md> [--json]
  list       [--dir context-packs]
  gen-briefs --out <dir> --workers <n> --pack <pack.md> [--seed <n>]`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!CMDS[cmd]) usage();
CMDS[cmd](getopt(rest));
