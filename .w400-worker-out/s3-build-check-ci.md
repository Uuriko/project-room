## Build / check / CI scripts

All claims verified against code in the worktree. `scripts/check.mjs` is the aggregator: it spawns each gate script and fails fast (scripts/check.mjs:26-74); `npm run check` invokes it (package.json). Most "no workflow" scripts below are reached through `check.mjs`, not directly from workflows.

| Script | Purpose | Usage | Failure modes | Called by |
|---|---|---|---|---|
| build-capabilities.mjs | Build-time capability inventory for deploy-aware discovery (#601); "what is deployed" == "what build is deployed" | `node scripts/build-capabilities.mjs` (args not inspected) | exit 1 on inventory failure | No direct workflow/npm ref found; likely consumed by discovery-profile tooling |
| build-gmail-sanitizer.mjs | Rebuild self-contained Gmail sanitizer so offline runtime packages boot; resolves esbuild via Node resolution anchored at cloudflare/package.json | `node scripts/build-gmail-sanitizer.mjs` | Throws on resolution failure | Manual / build process |
| build-og-atlas.mjs | Builds runtime OG assets (og/base-receipt.png, Inter glyph atlases, og/atlas.json) via Playwright | `npm run build:og-atlas`; re-run after font change | Playwright failure aborts build | package.json |
| build-push-sw.mjs | Classic service-worker build: inlines src/human-push-display.js so push-sw.js has no import (iOS 16.4–18.3 home-screen workers reject module workers) | `node scripts/build-push-sw.mjs` after editing display module | Build failure aborts | Manual |
| build-pwa-icons.mjs | Rasterize favicon.svg into PWA icon set via Playwright screenshot; maskable icons keep mark in center 80% safe zone | `node scripts/build-pwa-icons.mjs` | Playwright failure aborts | Manual |
| build-ui-strings.mjs | UI strings build/check (i18n) | `node scripts/build-ui-strings.mjs --check` | Non-zero when strings drift | scripts/check.mjs:26, package.json |
| check.mjs | Aggregator gate: fail fast with clear message on old Node (engines >=24.19.0); spawns all sub-gates | `npm run check` | exit 0/1; any sub-gate failure → exit 1 | package.json; CI via npm |
| check-deps.mjs | Fail fast when node_modules is stale relative to package.json | `node scripts/check-deps.mjs` | exit 1 when stale | zero-bug-gates.yml |
| check-deps-exist.mjs | Zero-bug gate: dependency-existence ("slopsquatting" defense); (1) registry existence for every declared dep, (2) … | `node scripts/check-deps-exist.mjs` | exit 1 on missing dep, exit 2 on registry/lookup failure | zero-bug-gates.yml |
| check-no-shadow-imports.mjs | CI gate: no const/let may shadow an imported name used earlier (runtime TDZ ReferenceError that `node --check` can't see; broke browser job on main once) | `node scripts/check-no-shadow-imports.mjs` | exit 1 on shadowing | scripts/check.mjs:30 |
| check-schema-version.mjs | CI gate: store schema number has exactly one source (STORE_SCHEMA_VERSION in server/writer-fence.mjs); everything else stating the number must match | `node scripts/check-schema-version.mjs` | exit 1 on mismatch | scripts/check.mjs:40 |
| ci-changes.mjs | Decide which expensive CI suites a PR actually needs (path-based; merging main retriggers suites) | Invoked by CI | No explicit exits (advisory) | qa2-agent-eval.yml, test.yml |
| verify-affected.mjs | `npm run verify:affected`: run only unit tests related to diff vs origin/main (+ uncommitted + untracked) | `npm run verify:affected [--list]` | Test failures propagate | package.json; human pre-push |
| coverage-thresholds.mjs | Per-module coverage thresholds gate (Q015); measures line coverage via V8 (NODE_V8_COVERAGE, zero deps) | `node scripts/coverage-thresholds.mjs` | exit 0/1/2 (2 = usage/measurement error) | test.yml |
| untested-modules-lint.mjs | Lists server/*.mjs with zero test references; fails if a NEW module joins the untested set or the grandfather list names a now-tested module (list only shrinks) | `node scripts/untested-modules-lint.mjs` | exit 1 on violation | test.yml |
| runtime-package.mjs | Offline exact-commit packaging verifier; standalone (copyable outside checkout); no install/upload/deploy | `node scripts/runtime-package.mjs` | Non-zero on packaging failure | test.yml |
| runtime-import-closure.mjs | Static import-closure analyzer for the runtime-package allowlist lint; computes transitive closure of relative ESM imports from an entrypoint | `node scripts/runtime-import-closure.mjs` | Non-zero on violation | No direct ref; consumed by runtime-package tests |
| stamp-version.mjs | Stamp immutable release metadata into server/version.mjs at bundle/deploy time; run after commit — stamped revision must name an existing commit, never a working tree | `node scripts/stamp-version.mjs` | Throws on dirty tree | Manual / deploy lane |
| sync-design-tokens-css.mjs | Regenerate design-token variable blocks in src/styles.css from src/design-tokens.js (single source of truth); :root (dark) + [data-theme="light"] marker comments | `node scripts/sync-design-tokens-css.mjs [--check]` | exit 1 on drift in --check | scripts/check.mjs:74 |

### Behavioral notes
- The "no workflow" rows are not dead code: `check.mjs` is the single funnel most of them run through, and `npm run check` is the human/CI entry point. A script with neither a workflow nor check.mjs nor package.json reference (e.g. stamp-version.mjs, runtime-import-closure.mjs) is manual/deploy-lane tooling — worth knowing before deleting.
- check-deps-exist.mjs exit 2 vs exit 1 distinction (lookup failure vs missing dep) lets CI tell "registry down" from "dep missing".

### Stale flags
- None found in this slice.

### Suspected bugs
- None found in this slice (headers accurately describe behavior; exit codes match).

DONE: 19 scripts, 0 stale flags, 0 suspected bugs
