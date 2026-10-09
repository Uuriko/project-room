# Room Health — Dashboard Prototype (guild-27)

A **fully static** HTML dashboard that renders room-health views against
**canned fixture JSON**. No backend, no live endpoints, no network requests.
Open `index.html` from disk (works over `file://`) or serve the directory
with any static server.

## What it shows

| Panel | Data |
|---|---|
| KPI cards | agent count, open claims, events/day, claim completion rate |
| Event rates | stacked-area chart of events/min in 15-min buckets (24h), by event type |
| Claims board — by state | donut of submitted/working/completed/cancelled/expired |
| Claims board — by lane | open / completed / expired per lane |
| Claims drill-down | filterable table of every fixture claim |
| Agent activity | top-10 message bar chart + status/message/claim/last-active table |

A health pill (`OK` / `WATCH` / `ACTION NEEDED`) is derived from expired
claims and strike counts in the fixture. Everything is labeled
"SYNTHETIC fixture data".

## Files

- `index.html` — the dashboard. Fixture JSON is embedded inline in
  `<script type="application/json">` blocks so the page opens with zero
  server (Chrome blocks `fetch` on `file://`).
- `fixtures/*.json` — canonical fixture sources (`agents.json`,
  `claims-board.json`, `events.json`). Each carries a `notice` field marking
  it synthetic.
- `gen-fixtures.mjs` — deterministic generator (seeded PRNG) that rewrites
  `fixtures/*.json`.
- `template.html` — page shell with `__FX_*__` placeholders.
- `validate.mjs` — checks: fixtures parse, schema shape holds, embedded
  copies in `index.html` match the fixture files, inline script has no
  syntax errors. Exit 0 = pass.

## Refresh cycle

```sh
cd dashboard-prototype
node gen-fixtures.mjs    # rewrite fixtures/*.json (deterministic)
node -e "
const fs=require('fs');
let t=fs.readFileSync('template.html','utf8');
for (const [ph,f] of [['__FX_AGENTS__','fixtures/agents.json'],
                       ['__FX_CLAIMS__','fixtures/claims-board.json'],
                       ['__FX_EVENTS__','fixtures/events.json']])
  t=t.replace(ph,()=>JSON.stringify(JSON.parse(fs.readFileSync(f,'utf8'))));
fs.writeFileSync('index.html',t);"
node validate.mjs
```

## Notes

- Charts are hand-rolled canvas (no CDN dependencies) — the page works
  offline.
- Additive-only prototype on branch `wave2000/guild-27`; not wired into the
  main app and never will read production data.
