# Credits Explorer UI Mock (hard task 118)

A read-only web UI for the credits explorer CLI
(`scripts/exchange/credits-explorer.mjs`: `balance`, `search`, `trace`,
`conservation`). Wireframes below are ASCII; the sample outputs are the
CLI's real output shapes, which the UI renders.

## Layout

```
+---------------------------------------------------------------+
| Credits Explorer                          [epoch: 12 ▾] [🔍]  |
+---------------------------------------------------------------+
| Overview | Journal | Trace | Conservation                     |
+---------------------------------------------------------------+
|                                                               |
|  <tab content>                                                |
|                                                               |
+---------------------------------------------------------------+
| read-only · data from ledger.sqlite · refreshed 12s ago       |
+---------------------------------------------------------------+
```

- **Overview tab:** total issued / circulating / redeemed cards + a
  per-epoch bar chart of issuance vs redemptions.
- **Journal tab:** the `search` command as a filter form
  (user / bounty / epoch fields + results table).
- **Trace tab:** the `trace` command — enter a journal id, get the
  provenance tree rendered as an indented tree (not flat text).
- **Conservation tab:** the `conservation` command as three big numbers
  + a green/red balanced indicator.

## Sample outputs for all commands

### balance

CLI: `credits-explorer.mjs --db ledger.sqlite balance alice` →

```
alice: 700cr
```

UI: the Overview tab's account lookup — type an account id, get the
balance card plus "last 5 journal entries touching this account" beneath.

```
+----------------------------------+
| alice                    700 cr  |
+----------------------------------+
| #41 transfer alice → bob 300cr   |
| #12 issuance ∅ → alice 1000cr    |
+----------------------------------+
```

### search

CLI: `credits-explorer.mjs --db ledger.sqlite search --user alice --epoch 1` →

```
#12 issuance ∅ → alice 1000cr epoch=1 ref=genesis nonce=9f2c1a4b
#41 transfer alice → bob 300cr epoch=1 ref=t1 nonce=77d0e2f1
— 2 entries
```

UI: the Journal tab renders the same rows as a table with sortable
columns (id, kind, from, to, amount, epoch, ref) and the filter form maps
1:1 to the CLI flags. Empty result sets say "no entries match — widen the
filters" instead of printing nothing.

### trace

CLI: `credits-explorer.mjs --db ledger.sqlite trace 41` →

```
#41 transfer alice → bob 300cr epoch=1 ref=t1 nonce=77d0e2f1
  #12 issuance ∅ → alice 1000cr epoch=1 ref=genesis nonce=9f2c1a4b
```

UI: the Trace tab renders the provenance as a collapsible tree; each
node links to the journal row (clicking a node jumps to the Journal tab
filtered to that entry). Depth > 25 is truncated with a "tree truncated"
notice (same guard as the CLI).

### conservation

CLI: `credits-explorer.mjs --db ledger.sqlite conservation` →

```
issued=1000 redeemed=0 circulating=1000 balanced=true
```

UI: the Conservation tab shows three cards (Issued / Redeemed+burned /
Circulating) and a large balanced indicator:

```
+------------+  +------------+  +-------------+
| ISSUED     |  | REDEEMED   |  | CIRCULATING |
| 1,000 cr   |  | 0 cr       |  | 1,000 cr    |
+------------+  +------------+  +-------------+
|  ✓ BALANCED — issued − redeemed = circulating  |
+------------------------------------------------+
```

When unbalanced, the indicator turns red and shows the delta — the
operator's cue to open the incident runbook (task 117), not to "fix" the
numbers.

## Non-goals

No write actions anywhere in the UI (it's a read-only explorer — issuance
and transfers happen elsewhere). No per-user pages beyond the account
lookup; no export in v1.
