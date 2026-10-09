# Dead-code analysis — guild-05 slice (guild-05 D8)

_Method: every function in the slice checked for callers (in-file + tests + CLI dispatch). Date: 2026-10-09._

## scripts/room
- All ~90 functions reachable: every cmd_* is dispatched in main()'s case; helpers called from verbs or the parse/reduce pipeline.
- Check: 78 definitions; main() case arms: 16
- No dead code found. (`_parse`, `_clock`, `_state` are test seams — used by tests.)

## scripts/herdr-migrate.mjs
- 2026-10-08 shepherd commit removed the dead classifyForExecute helper + unused imports (lint fix).
- Remaining exports all used: CLI dispatch table + tests import 1 test import site(s).
- No dead code found post-cleanup.

## scripts/runtime-package.mjs
- Exports: publicAssets, allowed, createRuntimePackage, verifyRuntimePackage — all used by tests + CLI main.
- Internals (assetsFor, runtimeMetadata, check, same, sha256) all called.
- v8Assets/dx1aAssets/operatorConsoleAssets: all three are spread into required/optional (verified by grep) — no dead declarations.
- Verdict: no dead code in scripts/runtime-package.mjs.
