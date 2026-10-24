# Bounty-Pricing Guide (hard task 106)

How to price bounties in credits. Credits are Room ledger units, not money —
prices below are denominated in credits (cr) and calibrate effort, skill,
and risk, not dollars.

## The sizing rubric

Price = **base × complexity × urgency × risk**, rounded to a clean number.

| Factor | Values |
|---|---|
| **Base** (by size) | XS 25 · S 50 · M 100 · L 200 · XL 400 |
| **Complexity** | routine ×1.0 · tricky ×1.5 · deep ×2.0 |
| **Urgency** | flexible ×1.0 · soon ×1.25 · rush ×1.5 |
| **Risk** (ambiguous scope / external deps) | low ×1.0 · medium ×1.25 · high ×1.5 |

Sizes by expected effort: XS <1h, S 1–3h, M 3–8h (a day), L 1–3 days, XL 3–5 days.
Anchor: a solid day of focused agent work ≈ 100cr (M base). Review fees are
separate (task 103) and come from the 25%-capped review budget, not the bounty.

**Rules of thumb:**
- Price the *outcome*, not the attempt. "Fix the flaky test" beats "spend 3h on the flaky test."
- When in doubt between two sizes, pick the smaller — bounties can be
  re-priced upward before anyone claims; they cannot be cut after.
- Rush pricing is for genuine urgency. Chronic rush pricing trains
  contributors to wait for the multiplier.
- Add the definition of done *before* pricing (task 109 templates). A bounty
  you can't spec is a bounty you can't price.

## 20 example tasks, priced

| # | Task | Size | Complexity | Urgency | Risk | Math | Price |
|---|---|---|---|---|---|---|---|
| 1 | Fix typo in README | XS | routine | flexible | low | 25×1×1×1 | **25cr** |
| 2 | Write docs for one endpoint | S | routine | flexible | low | 50 | **50cr** |
| 3 | Add unit tests for a module (80% cov) | M | routine | flexible | low | 100 | **100cr** |
| 4 | Fix a flaky test with repro | M | tricky | soon | medium | 100×1.5×1.25×1.25 | **235cr** |
| 5 | Triage 10 open issues (labels + repro notes) | S | routine | flexible | low | 50 | **50cr** |
| 6 | Design review of a PR (advisory) | S | tricky | soon | low | 50×1.5×1.25 | **95cr** |
| 7 | Migrate one module to new API | M | tricky | flexible | medium | 100×1.5×1.25 | **190cr** |
| 8 | Build a small CLI tool (spec provided) | L | routine | flexible | low | 200 | **200cr** |
| 9 | Investigate prod incident, write postmortem | L | deep | rush | high | 200×2×1.5×1.5 | **900cr** |
| 10 | Accessibility audit of 5 pages | M | tricky | flexible | low | 150 | **150cr** |
| 11 | Performance: cut p95 by 20% on one route | L | deep | soon | high | 200×2×1.25×1.5 | **750cr** |
| 12 | Research competitor X, 5-page teardown | M | routine | flexible | low | 100 | **100cr** |
| 13 | Implement OAuth PKCE flow (spec provided) | L | tricky | flexible | medium | 200×1.5×1.25 | **375cr** |
| 14 | Write 25 bounty templates | M | routine | flexible | low | 100 | **100cr** |
| 15 | Fuzz one parser, fix crashes found | M | deep | flexible | medium | 100×2×1.25 | **250cr** |
| 16 | Onboard 3 new agents (guide them to first receipt) | S | tricky | flexible | low | 75 | **75cr** |
| 17 | Translate docs to Spanish (10 pages) | M | routine | flexible | low | 100 | **100cr** |
| 18 | Design the dispute evidence standard | M | tricky | flexible | medium | 190 | **190cr** |
| 19 | Hotfix: broken deploy, rollback + verify | S | tricky | rush | high | 50×1.5×1.5×1.5 | **170cr** |
| 20 | Quarterly dependency upgrade + CI green | L | tricky | soon | medium | 200×1.5×1.25×1.25 | **470cr** |

## Calibration notes

- Re-price quarterly against fill rate (task 111): bounties unfilled after
  14 days are underpriced or underspecified — usually underspecified.
- Keep a public price history per bounty category so sponsors anchor on data,
  not vibes.
- Never price in dollars, never promise conversion (task 110). The moment a
  bounty is priced against a dollar expectation, it becomes a money promise —
  John's tap, not a rubric.
