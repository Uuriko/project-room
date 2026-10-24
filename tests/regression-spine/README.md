# Regression spine — hunt-findings replay pack (QA-R1)

One row per defect finding from hunt waves 1–3 (deliverables in
`~/workspace/hunt-2026-10-18/`), one executable replay probe per row, one
runner that classifies every row against a local build:

- **STILL-REPRODUCES (P0 attention)** — the original repro still produces
  the filed defect behaviour. For findings whose fix PRs are still queued
  under the RELEASE-PAUSE this is the pack *working*: the row flips to
  FIXED only when the fix actually lands and the behaviour changes.
- **FIXED** — the repro now refuses, heals, or is absent, as the finding's
  expected-fixed behaviour describes.
- **NOT-REPRODUCIBLE-AS-FILED** — the repro could not be executed as filed
  in this environment, or the lane's own follow-up refuted it. The reason
  is always stated in the row's evidence; a NOTFILED row is never a silent
  skip.

## Run it

```sh
node tests/regression-spine/run.mjs [--root <tree>] [--out <dir>] [--only ID,ID] [--timeout <sec>]
```

Defaults: `--root` is the repo root (the pack lives in `tests/`), output
is stdout only. With `--out`, the runner also writes `classification.md`
and `classification.json`. Probes need a **writable** tree (the repo's
acceptance fixture materialises a generated module under `scripts/`, and
mutation probes work on private copies under `TMPDIR`). Set `TMPDIR` to a
scratch directory with room for several tree copies (~50 MB each).

## Method

- Where a lane left a repro script, the probe runs that script
  **unmodified** except for its tree-root import prefix, vendored under
  `probes/vendor/` (patrol-diagnosis, orphans C1/C4, adversary P1/P3,
  loss-1, race R-2, soak S-1/S-6). Verdicts are parsed from the scripts'
  own result lines.
- Where the lane filed a transcript instead, the probe is a faithful
  re-derivation using the same doors, call shapes and assertions
  (differential D-1/D-2/D-3, the escrow family, the stranger doors).
- Coverage rows re-run the coverage lane's own mutation method: the
  lane's mutation spec (vendored) is applied to a private copy of the
  tree and the pin suite from the fix PR is executed against it. A
  mutation that only an unlanded pin catches still classifies
  STILL-REPRODUCES — the shipped suite is blind to it.
- Mechanism findings with no dynamic repro (charters, source-level
  defects) get a mechanism probe over the exact cited code, with the
  filed shape and the fix shape both named; a source matching neither
  reports NOT-REPRODUCIBLE-AS-FILED so the row gets re-derived rather
  than silently passing.
- Findings the lanes themselves refuted, and organisational/process
  items with no local repro, are rows with `probe: "none"` and the
  reason on the record — the inventory is complete even where no
  executable replay exists.

## Severity mapping

Row severities are assigned from the QA wave plan's harm ladder
(`~/workspace/strategy-2026-10/qa-wave-plan-2026-10-18.md` §3), mapped
from the hunt lanes' own grades: money-loss / safety / privacy defects
with a working repro are P0–P1; correctness and supervision defects P1;
scale, coverage and copy defects P2; suspects, refuted items and
informational entries P3. STILL-REPRODUCES rows should be read with
their severity: a still-reproducing P0 is a launch blocker, a
still-reproducing P3 is a tracked known.

## Charter cross-reference

The TRIAGE charters (01–11) are dispositions of findings already in this
pack, not separate rows: 01 = LOSS-3's sites · 02 = STR-S2 · 03 = STR-S4 ·
04 = STR-S1/S7/S11 · 05 = STR-S5/S6 · 06 = SCALE-6 (C-2) · 07 = RACE-S1 ·
08 = ADV-P6 · 09 = ADV-P7 · 10 = LOSS-4 · 11 = WATCH-P6/P8/P10. When a
charter's fix lands, the corresponding rows flip.

## Dependencies

- **QA-T0-SEEDS**: the pack builds minimal local fixtures inline (the
  acceptance fixture, an in-memory escrow world, vendored repro seeds)
  because the seed packs were not yet filed when this pack was built.
  When QA-T0 files its packs, the fixture helpers in `lib.mjs` should be
  re-pointed at them; probe assertions do not depend on fixture shape.
- The pack never touches production: every probe runs against a local
  tree, a local fixture server on an ephemeral port, or an in-memory
  store.

## Round-2 reuse (QA-R2)

The runner and manifest format are the round-2 substrate: new findings
append rows; existing rows re-run unchanged. A row whose probe starts
reporting NOTFILED after a refactor is the signal to re-derive that
probe — that is the spine doing its job.
