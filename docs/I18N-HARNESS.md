# i18n Harness (Q012)

Harness-first measurement of i18n readiness. It does not translate anything;
it extracts user-facing strings and checks them against readiness rules, as a
CI lint-like gate.

## What it scans

- UI strings: `src/**/*.js` and root `*.html` pages
- Email templates: `server/notify-email.mjs`, `server/email-envelope.mjs`
- Error messages: `throw new Error("…")` / `new Error("…")` literals in `server/**/*.mjs`

The harness only **reads** these files. It never edits UI code.

## Rules

| rule | what it flags | readiness target |
|---|---|---|
| `hardcoded-ui-string` | prose-like literal found in source, outside the strings catalog | every user-facing string lives in `strings/en.json`, referenced by key |
| `sentence-concatenation` | sentences built with binary `+` or template literals with 2+ interpolations | one full translatable sentence per catalog entry, never assembled from parts |
| `positional-placeholder` | `{0}`, `%s`, `%d` style positional placeholders | named placeholders only: `{count}`, `{name}` |

## Usage

```sh
node scripts/i18n-harness.mjs --report    # human-readable summary
node scripts/i18n-harness.mjs --extract   # full violation JSON
node scripts/i18n-harness.mjs --check     # CI gate: fail if any rule count grew past baseline
node scripts/i18n-harness.mjs --baseline  # regenerate strings/i18n-baseline.json
```

`--check` runs inside `npm run lint`, so it gates CI.

## Baseline ratchet

`strings/i18n-baseline.json` records violation counts at generation time.
`--check` exits 1 only when a rule's count **grows** beyond the baseline — the
current codebase is grandfathered in; new hardcoded strings get caught. When
code is migrated into the catalog (counts drop), regenerate the baseline so
the ratchet tightens:

```sh
node scripts/i18n-harness.mjs --baseline
```

## Strings catalog

`strings/en.json` is the seed catalog: notification-email copy with named
placeholders. Future migrations move hardcoded strings here and reference them
by key (e.g. `t("email.batch.subject_many", { count })`); no `t()` helper
ships with this harness — that is a later backlog item.
