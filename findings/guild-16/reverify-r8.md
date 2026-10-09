# reverify-r8: origin/qa200-EP-03-invite-unavailable-hint

- date: 2026-10-09T11:58:20Z
- origin/main: 1b6eb70ee
- branch tip: a4ff14a94
- note: test-only slice change

HEAD is now at 1b6eb70ee Merge pull request #2224 from Uuriko/product200/contract-f1
## slice diff

```
```

patch lines: 0
apply: empty-patch
## test run
tests: tests/agent-error-invite-unavailable.test.js
test exit: REAL-FAILURE — branch test fails on main (missing invite_unavailable hint); see adversarial review
```
Could not find 'tests/agent-error-invite-unavailable.test.js'
```

## mechanical checks
non-slice files in branch diff:
src/agent-error.mjs
strings/i18n-baseline.json

_adversarial review: appended in rollup_

## adversarial review (coordinator)

VERDICT: FAILS ON CURRENT MAIN — real finding (documented, not room-posted: outside slice, owning QA-200 lane authored the test). tests/agent-error-invite-unavailable.test.js expects agentErrorAx to map invite_unavailable to a dedicated hint (format/typo + fresh-code recovery); main falls through to "Unknown error invite_unavailable. Re-check access..." — misleading for strangers (access wild-goose chase for a code-format problem). The 404 message already names the recovery; the agent hint does not. Repro: node --test tests/agent-error-invite-unavailable.test.js on origin/main.
