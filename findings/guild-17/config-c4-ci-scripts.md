# Config C4: CI configuration — package.json scripts surface

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Scripts relevant to CI (from package.json)
`pretest`, `test`, `verify:affected`, `test:quarantined`, `test:relay`,
`test:refine`, `test:browser`, `test:browser:ci`, `lint`, `test:handoff`, `test:machine`, …

## Mapping to required checks [test, contract, lint, browser, cloudflare]
- `test.yml` is the monolith that fans out into unit shards (3), browser shards (6),
  contract, lint, and cloudflare jobs — the required-check names correspond to
  **jobs inside test.yml** (verified: `test.yml` contains jobs named for the check
  contexts; `zero-bug-quarantine.yml` also emits a `test` context, `zero-bug-gates.yml`
  a `cloudflare` context — per G1 evidence).
- **Two workflows emit the `test` check** (test.yml, zero-bug-quarantine.yml) and two
  emit `cloudflare` (test.yml, zero-bug-gates.yml). GitHub treats same-name checks
  from different workflows as separate check runs that must ALL be green when the
  context is required... actually: required status check "test" is satisfied when
  the **latest** run for that context succeeds; multiple runs with the same name
  each need to succeed (GitHub requires all check runs matching the context name
  to be successful). Either way, both workflows' runs must be green. This is
  stricter than it looks — fine.
- `verify:affected` (npm script): tests related to the diff vs origin/main.
  Known quirk (AGENTS.md): can hang >180s; fallback is targeted `node --test`.
  It is a **local/CI helper, not a GitHub check** — the merge gate does not know
  about it. Fine.
- `lint` script: eslint + design tokens + reachability + i18n + UI strings —
  feeds the `lint` required check via test.yml's lint job.

## Verdict: PASS. Check-name mapping is coherent; the required contexts are all
produced by test.yml's jobs. Observation for D1 docs: the check-name → job
mapping is non-obvious (5 contexts, mostly inside one workflow file) and worth
a diagram.
