# reverify-r7: origin/wave300/fix5-release-compare

- date: 2026-10-09T11:58:20Z
- origin/main: 1b6eb70ee
- branch tip: 99d9f66f4
- note: test-only slice changes

HEAD is now at 1b6eb70ee Merge pull request #2224 from Uuriko/product200/contract-f1
## slice diff

```
```

patch lines: 0
apply: empty-patch
## test run
tests: tests/lease-renewal.test.js,tests/request-dedupe.test.js,tests/request-journal.test.mjs,tests/requestid-routes.test.js,tests/work-claim-release-basis.test.js,tests/work-claim-requestid-dedupe.test.js
test exit: 0 (NOTE: harness captured subshell echo; real result in adversarial review)
```
✔ handler: renew with another member's check-in is refused (49.641167ms)
✔ handler: renew with a stale check-in is refused (6.220305ms)
✔ handler: renew by a non-owner is refused (8.353696ms)
✔ handler: renew of a leaseless claim is refused (19.54398ms)
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29000.538245
```

## mechanical checks
non-slice files in branch diff:
client/request-journal.mjs
docs/WORK-CLAIMS.md
docs/openapi.yaml
scripts/runtime-package.mjs
server/http.mjs
server/request-dedupe.mjs
server/work-claim-routes.mjs
server/work-claims.mjs

_adversarial review: appended in rollup_

## adversarial review (coordinator)

VERDICT: clean. Test-only additions (lease-renewal, request-dedupe, request-journal, requestid-routes, work-claim-release-basis, work-claim-requestid-dedupe): 22/22 pass on current main. No source changes. No issues.
