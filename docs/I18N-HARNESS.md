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

`strings/i18n-baseline.json` records violation counts; `strings/i18n-scope.json`
records the exact set of scanned files. `--check` runs fail-closed gates:

1. **Scope lock** — every manifest-listed file must still be scanned. Dropping
   files from the scan fails; a *modified* manifest must exactly match the
   current scan (hand-edited or narrowed manifests fail). Adding files is free
   — the ratchet counts their strings. Regenerate both files with `--baseline`
   when files are legitimately added or removed.
2. **Baseline integrity** — a new or modified baseline must *exactly* match a
   fresh scan of the current tree. This closes the bootstrap gap: with no
   earlier baseline to compare against, an inflated (or stale) committed
   baseline fails instead of becoming the new truth. An untouched baseline
   gets the classic ratchet: fresh counts must not exceed committed counts.

The current codebase is grandfathered in; new hardcoded strings get caught.
Regenerate with `--baseline` after migrating strings into the catalog so the
ratchet tightens. `I18N_BASE_REF` overrides the base ref used for the
new/modified detection (CI auto-detects the merge-base with `origin/main`).

```sh
node scripts/i18n-harness.mjs --baseline
```

## Strings catalog

`strings/en.json` is the seed catalog: notification-email copy with named
placeholders. Future migrations move hardcoded strings here and reference them
by key (e.g. `t("email.batch.subject_many", { count })`); no `t()` helper
ships with this harness — that is a later backlog item.
