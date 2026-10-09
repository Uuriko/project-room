// d04: finding pipeline (submit / collect / validate / verify).
import { writeFileSync } from "node:fs";
const OUT = process.argv[2] + "/docs";
writeFileSync(OUT + "/finding-pipeline.md", `# Finding pipeline (guild-11 slice docs)

The telemetry-bus finding record flows through four zero-dependency CLIs.
Spec: \`telemetry/finding-schema.json\` (canonical), mirrored by hand-rolled
validators in validate.mjs, verify.mjs, and collect.mjs (three copies — see
gotchas).

## Record shape

Required: id, guild, claim, evidence, numbers, timestamp.
- id: ^[a-z0-9-]+$ (submit.mjs generates \`tb-<UTC yyyymmddHHMMSS>-<4 hex>\`)
- claim / evidence: strings, length >= 10
- numbers: plain object of finite numbers
- timestamp: ISO8601 UTC (verify.mjs additionally requires the strict
  \`YYYY-MM-DDTHH:MM:SS(.sss)Z\` form)
- optional: category (7-enum), confidence (high|medium|low), agent (string),
  roomSeq (integer), source (string)

## submit.mjs — authoring

\`node telemetry/submit.mjs --guild <g> --claim "<c>" --evidence "<e>"
--numbers '{"k":1}' [--category ..] [--confidence ..] [--agent ..] [--room-seq N]\`

- Validates args, fails CLOSED (nonzero exit, writes nothing) on: missing
  guild/claim/evidence, claim/evidence < 10 chars, --numbers not a JSON
  object, bad category/confidence, non-integer --room-seq, positional args.
- Appends one JSONL line to \`$CWD/telemetry/findings.jsonl\` (cwd-relative —
  run it from the repo root). Prints the generated id.

## collect.mjs — room ingestion (offline fixture mode)

\`node telemetry/collect.mjs --events <events.json>\`

- File mode expects \`{ events: [ { sequence, event: { type, data: { body } } } ] }\`.
- Room-native format: body must START with \`FINDING\` (first line), then one
  fenced \`\`\`json block with exactly one record. Anything else is
  "not-finding" and skipped silently; malformed fenced JSON or spec-invalid
  records are "rejected" and counted.
- Dedupes on id against the existing findings.jsonl (same id twice ->
  "skipped N dupes"); reruns are idempotent.
- Prints: \`collected N new, skipped M dupes, rejected K invalid\`.
- Corrupt lines in the EXISTING findings.jsonl are skipped (not fatal).
- \`--live\` hits the production room API — lead approval only; not used here.

## validate.mjs — single-record check

\`node telemetry/validate.mjs <finding.json>\` — prints PASS/FAIL with reasons,
exit 0/1. Never throws on hostile input (fuzz f01/f02: 201 inputs, zero
crashes). Note: numbers must be FINITE — JSON cannot express NaN/Infinity, so
that check is belt-and-braces.

## verify.mjs — acceptance harness

\`node telemetry/verify.mjs\` (full mode A-F) or \`TELEM_DIR=telemetry/selftest
node telemetry/verify.mjs\` (A+B only):

- A: finding-schema.json has exactly the 6 required fields, numbers is an object.
- B: every examples/*.json passes the spec; every examples/invalid/*.json is
  REJECTED (unparseable JSON counts as rejected).
- C: findings.jsonl (if present): every line parses, is spec-valid, ids unique.
- D: dashboard.html hooks (see data-flow.md).
- E: submit.mjs with no args exits nonzero; collect.mjs exists.
- F: no .mjs POSTs to room.trydemigod.com.

Self-test mode exists so sibling guilds can verify A+B without the dashboard.
`);
console.log("d04 wrote docs/finding-pipeline.md");
