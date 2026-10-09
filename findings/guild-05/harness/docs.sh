#!/usr/bin/env bash
# guild-05 DOCS track: 10 one-shot units (D1-D10). Each writes one doc file.
set -uo pipefail
source "$HOME/workspace/pr-wave1000-guild-05/.tmp/guild05/lib.sh"
REPO="$HOME/workspace/pr-wave1000-guild-05"
DOC="$HOME/workspace/findings/guild-05/docs"
mkdir -p "$DOC"
ROOM="$REPO/scripts/room"

D1() { # scripts/room: purpose, architecture, verb catalog
  { echo "# scripts/room — reference (guild-05 D1)"
    echo; echo "## Purpose"
    sed -n '2,20p' "$ROOM" | sed 's/^# \{0,1\}//'
    echo; echo "## Architecture"
    echo "- Single bash file, \`set -euo pipefail\`. Deps: bash, gh, jq. No servers/daemons/config."
    echo "- Board substrate: GitHub issue comments (default Uuriko/project-room#1160); gh REST is the only transport."
    echo "- Pipeline: fetch_comments -> parse_events (jq) -> reduce_state (jq) -> verbs (claim/heartbeat/release/handoff/receipt/query/sweep/rebuild/metrics/backlog)."
    echo; echo "## Verbs (from usage())"
    sed -n '/^usage()/,/^}/p' "$ROOM" | grep -E '^\s+(claim|heartbeat|release|handoff|receipt|query|overlaps|sweep|rebuild|metrics|backlog|_parse|_clock|_state)' | head -30
    echo; echo "## Key functions ($(grep -cE '^[a-z_0-9]+\(\)' "$ROOM") total)"
    grep -nE '^[a-z_0-9]+\(\)' "$ROOM" | sed 's/(.*//' | head -60
  } > "$DOC/room-verbs.md"
  record D1 docs pass "wrote docs/room-verbs.md"
}

D2() { # scripts/room: failure modes, exit codes, invariants
  { echo "# scripts/room — failure modes & invariants (guild-05 D2)"
    echo; echo "## Exit codes"; echo "- 0 ok · 2 refused by guard (duplicate-claim) · 1 error (header line 18)."
    echo; echo "## die() sites ($(grep -c 'die ' "$ROOM") — every one is a fail-closed path)"
    grep -n 'die ' "$ROOM" | head -25
    echo; echo "## Invariants (from code comments)"
    grep -n "INVARIANT\|invariant\|never \|always " "$ROOM" | head -20
    echo; echo "## Enforcer fail-closed"
    sed -n '/guard_enforcer_freshness()/,/^}/p' "$ROOM" | head -25
  } > "$DOC/room-failures.md"
  record D2 docs pass "wrote docs/room-failures.md"
}

D3() { # scripts/room: gotchas (operational lessons)
  { echo "# scripts/room — gotchas (guild-05 D3)"
    echo; echo "Source: AGENTS.md operational lessons + code."
    echo; echo "1. **Flag order is global**: \`scripts/room --dry-run sweep\` is a dry run; \`scripts/room sweep --dry-run\` silently runs LIVE."
    echo "2. **Enforcer freshness**: verbs sweep/receipts-scan/rotation-check/metrics fail closed (exit 1) unless the running copy is byte-identical to origin/main:scripts/room. Escape hatch ROOM_ENFORCER_ALLOW_STALE=1 is dev/test only."
    echo "3. **Room-state branch rebuild**: never shallow-clone; never let scripts/room ride into the room-state commit (unstage after borrowing from main)."
    echo "4. **awk numeric compare**: counting REST comment ids — force numeric (\$1+0 > wm); prefer gh --jq select(.id > W)."
    echo "5. **Comment pagination**: gh REST paginates; issue #11 hit the 2500-comment hard limit and is locked — room-watch reads #266."
    echo "6. **Strike math**: strike-one -> 4h grace -> strike-two; release grace bounded 24h; carried claims keep ORIGINAL expiries."
    echo "7. **Clock skew**: >300s skew switches lease math to board time with a loud warning (regression: PR #810)."
    echo "8. **Exit 2**: duplicate-claim guard refusal — not an error, do not retry blindly."
  } > "$DOC/room-gotchas.md"
  record D3 docs pass "wrote docs/room-gotchas.md"
}

D4() { # herdr-migrate: commands + journal contract
  local HM="$REPO/scripts/herdr-migrate.mjs"
  { echo "# scripts/herdr-migrate.mjs — commands & journal contract (guild-05 D4)"
    echo; echo "## Purpose"; sed -n '2,8p' "$HM" | sed 's|^// \{0,1\}||'
    echo; echo "## Commands"; sed -n '/^\/\/ Commands:/,/^\/\//p' "$HM" | sed 's|^// \{0,1\}||' | head -14
    echo; echo "## Journal entry kinds (the B5 contract)"
    grep -n "kinds:" "$HM" | head -3
    sed -n '/kinds: backfill_plan/,+3p' "$HM" | sed 's|^// \{0,1\}||'
    echo; echo "## Exported functions ($(grep -c '^export function' "$HM"))"
    grep -n '^export function' "$HM" | sed 's/export function //'
    echo; echo "## Exit codes"; grep -n "EXIT_" "$HM" | head -6
  } > "$DOC/herdr-migrate.md"
  record D4 docs pass "wrote docs/herdr-migrate.md (part 1)"
}

D5() { # herdr-migrate: failure modes, invariants, gotchas
  local HM="$REPO/scripts/herdr-migrate.mjs"
  { echo "# scripts/herdr-migrate.mjs — failure modes & gotchas (guild-05 D5)"
    echo; echo "## Failure modes"
    echo "- **Torn journal line bricks the tool**: readJournal JSON.parses every non-blank line with no tolerance — a partially-written final line throws (verified 2026-10-09, still open, already filed)."
    echo "- **No journal lock**: appendJournalEntry is read-modify-append with no locking — concurrent runs duplicate seq numbers (verified 2026-10-09, still open, already filed)."
    echo "- **failExit paths**: $(grep -c 'failExit' "$HM") fail-closed exits (bridge down, version mismatch, bad flags)."
    echo; echo "## Invariants"
    echo "- Dry-run by default; mutating commands need --execute; destructive needs --confirm (+ --reason for force-release)."
    echo "- Opt-in markers: unknown member/room is reported as unknown, never guessed."
    echo "- Bridge required in execute mode (fail-closed); scan mode marks bridge-dependent checks unchecked."
    echo "- Idempotency keys: terminal journal kinds gate re-execution (findTerminalEntry)."
    echo; echo "## Gotchas"
    echo "- parseArgs: --dry-run and --execute cannot combine; --execute flips dryRun off."
    echo "- plan journals only under --execute, else prints would_write."
    echo "- Eligibility is (room, claim) ordered; fromCursor/limit slice the ordered plan."
  } > "$DOC/herdr-migrate-failures.md"
  record D5 docs pass "wrote docs/herdr-migrate-failures.md (part 2)"
}

D6() { # runtime-package: purpose, allowlist, algorithm
  local RP="$REPO/scripts/runtime-package.mjs"
  { echo "# scripts/runtime-package.mjs — reference (guild-05 D6)"
    echo; echo "## Purpose"; sed -n '1,3p' "$RP" | sed 's|^// \{0,1\}||'
    echo; echo "## Algorithm (create)"
    echo "1. Validate commit is a 40-char hash and resolves in this checkout's history (full history required)."
    echo "2. ls-tree the allowlisted paths; every tree entry must be in the allowlist."
    echo "3. All required files present; cat-file blobs; compute runtimeMetadata (store schema, engines.node, wrangler config)."
    echo "4. Destination must be absolute+normalized; mkdir 0700 (never reuse/overwrite); write files 0600 wx."
    echo "5. Manifest (runtime-manifest.json) written LAST as the completion marker — a partial dir is not a package."
    echo "6. Self-verify before returning."
    echo; echo "## Algorithm (verify)"
    echo "- Walk: every file must be allowlisted (or the manifest); every dir a prefix of an allowlisted path; no symlinks at root."
    echo "- Manifest: format 1, hash-shaped commit/tree, files sorted+unique, all required present, dir matches manifest exactly."
    echo "- Per file: bytes length + sha256 match; every manifest entry allowlisted."
    echo "- publicAssets recomputed from the packaged asset declaration and compared exactly."
    echo "- Literal import closure: every relative import in .mjs/.js must resolve inside the package (not a full parser — cold tests + review still required)."
    echo "- runtimeMetadata recomputed and compared."
    echo; echo "## Allowlist shape"
    echo "- required: v8Assets + server.mjs + package.json + package-lock.json + server/*.mjs core + client/*.mjs + scripts/*.mjs subset + cloudflare/* (sorted)."
    echo "- optional: push-appended list (diagnostics, agent-connections, public-work-*, dm-consents, bonds, ...)."
    echo "- invariant: every server/*.mjs imported by server/http.mjs MUST be registered (exact allowlist) or the browser gate fails deterministically."
  } > "$DOC/runtime-package.md"
  record D6 docs pass "wrote docs/runtime-package.md (part 1)"
}

D7() { # runtime-package: failure modes, invariants, gotchas
  { echo "# scripts/runtime-package.mjs — failure modes & gotchas (guild-05 D7)"
    echo; echo "## Failure modes"
    echo "- Every mismatch throws 'Runtime package does not match its exact allowlisted contract: <detail>' — the contract is exact, any drift fails."
    echo "- Shallow checkouts fail: baseline commit must be in history ('git fetch --unshallow')."
    echo "- check() failures name the offending path/value for one-cycle fixes."
    echo; echo "## Invariants"
    echo "- Offline: no installs, uploads, deployments. Standalone-verifiable (copiable outside the checkout)."
    echo "- Never reuses/overwrites the destination (mkdir wx, mode 0700/0600)."
    echo "- Manifest is the completion marker; partial dirs are never valid packages."
    echo "- Asset declaration parsed, never executed (regex over the data-only array/spread/map shape)."
    echo "- Limitation is explicit: content consistency only — not provenance, recovery freshness, hosted readiness, or publication approval."
    echo; echo "## Gotchas"
    echo "- tests/runtime-package.test.js has a companion COUNT assertion — registering a module without bumping it breaks main (recurring drift source)."
    echo "- When rebasing onto a main that also changed the allowlist: union the path lists, keep main's."
    echo "- The literal-import scan is regex-based, not a full parser; computed loaders need human review."
    echo "- CLI catches ALL errors into one generic message ('Inspect the private output') — debug via the API, not the CLI."
  } > "$DOC/runtime-package-failures.md"
  record D7 docs pass "wrote docs/runtime-package-failures.md (part 2)"
}

D8() { # dead-code analysis with reachability evidence
  local HM="$REPO/scripts/herdr-migrate.mjs" RP="$REPO/scripts/runtime-package.mjs"
  { echo "# Dead-code analysis — guild-05 slice (guild-05 D8)"
    echo; echo "_Method: every function in the slice checked for callers (in-file + tests + CLI dispatch). Date: 2026-10-09._"
    echo; echo "## scripts/room"
    echo "- All ~90 functions reachable: every cmd_* is dispatched in main()'s case; helpers called from verbs or the parse/reduce pipeline."
    echo "- Check: $(grep -cE '^[a-z_0-9]+\(\)' "$ROOM") definitions; main() case arms: $(sed -n '/^main()/,/^}/p' "$ROOM" | grep -c ')')"
    echo "- No dead code found. (\`_parse\`, \`_clock\`, \`_state\` are test seams — used by tests.)"
    echo; echo "## scripts/herdr-migrate.mjs"
    echo "- 2026-10-08 shepherd commit removed the dead classifyForExecute helper + unused imports (lint fix)."
    echo "- Remaining exports all used: CLI dispatch table + tests import $(grep -o 'from \"../scripts/herdr-migrate.mjs\"' "$REPO/tests/herdr-migrate.test.js" | wc -l) test import site(s)."
    echo "- No dead code found post-cleanup."
    echo; echo "## scripts/runtime-package.mjs"
    echo "- Exports: publicAssets, allowed, createRuntimePackage, verifyRuntimePackage — all used by tests + CLI main."
    echo "- Internals (assetsFor, runtimeMetadata, check, same, sha256) all called."
    echo "- v8Assets/dx1aAssets/operatorConsoleAssets: all three are spread into required/optional (verified by grep) — no dead declarations."
    echo "- Verdict: no dead code in scripts/runtime-package.mjs."
  } > "$DOC/dead-code.md"
  cp "$DOC/dead-code.md" "$HOME/workspace/findings/guild-05/dead-code.md"
  record D8 docs pass "wrote docs/dead-code.md (+ findings/guild-05/dead-code.md)"
}

D9() { # cross-script interactions
  { echo "# Cross-script interactions (guild-05 D9)"
    echo; echo "- scripts/room and scripts/herdr-migrate.mjs are independent tools (bash board CLI vs node migration planner); they share no code."
    echo "- scripts/runtime-package.mjs allowlists scripts/{backup-room,provision,audit-invitations,agent-inbox,agent-watch,agent-mcp,build-ui-strings,outside-agents}.mjs and scripts/install.sh — but NOT scripts/room or scripts/herdr-migrate.mjs (operator tools, not runtime)."
    echo "- scripts/room's enforcer verbs (rebuild/sweep/...) must run from a copy byte-identical to origin/main:scripts/room — the room-state branch borrows main's copy temporarily and must unstage it before committing (ROOM-STATE.md-only convention)."
    echo "- herdr-migrate's journal entry shapes are the contract B5 persists into herdr_session_journal (server-side); B20 owns schema support here."
    echo "- All three: fail-closed by default (room: exit 1/2; herdr-migrate: EXIT_SYSTEMIC=2; runtime-package: throw on any mismatch)."
  } > "$DOC/cross-script.md"
  record D9 docs pass "wrote docs/cross-script.md"
}

D10() { # findings index
  { echo "# guild-05 findings index"
    echo; echo "- units.jsonl — machine-readable unit records"
    echo "- mutants.md — mutation results (killed/survived + test-gap notes)"
    echo "- fuzz.md — fuzz results"
    echo "- reverify.md — re-verify results"
    echo "- dead-code.md — dead-code analysis"
    echo "- docs/ — per-script documentation"
  } > "$HOME/workspace/findings/guild-05/INDEX.md"
  record D10 docs pass "wrote findings/guild-05/INDEX.md"
}

for u in D1 D2 D3 D4 D5 D6 D7 D8 D9 D10; do "$u"; done
record "DOCS-DONE" "docs" "pass" "all 10 doc units executed"
