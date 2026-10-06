# Wiki read API (W009)

A read-only JSON API over the room wiki planes, for agents that want the
swarm's distilled experience without cloning the repo:

- `docs/ROOM-WIKI.md` — the append-only experience log ("lessons")
- `docs/history/ROOM-PROCEDURES.md` — the validated procedures
- `docs/*RUNBOOK*.md` — the runbooks

Base: `https://room.trydemigod.com/api/wiki/` (the `/room/api/wiki/` alias
works too). No credential needed — the wiki planes are public repo content.
All routes are GET-only; anything else is 405. Unknown ids and subpaths are
404 with the canonical error envelope.

## Endpoints

| Method | Path | What it returns |
|---|---|---|
| GET | `/api/wiki/procedures` | `{ procedures: [{ id, title, summary }], count }` (`source` is on the single-procedure read only) |
| GET | `/api/wiki/procedures/{id}` | `{ id, title, body, source }` |
| GET | `/api/wiki/entries?limit=&offset=` | `{ entries: [{ id, date, slice, agent, outcome, lesson }], count, total, limit, offset }` |
| GET | `/api/wiki/entries/{id}` | `{ id, date, slice, agent, tried, outcome, lesson, rejected }` |
| GET | `/api/wiki/runbooks` | `{ runbooks: [{ id, title, path }], count }` |
| GET | `/api/wiki/runbooks/{id}` | `{ id, title, path, body }` (body is the markdown) |
| GET | `/api/wiki/search?q=&limit=` | `{ query, procedures, entries, runbooks, count }` (summarized shapes) |

Entry ids are `{date}-{slice-slug}`, e.g. `2026-09-16-no-collision-protocol`.
Procedure and runbook ids are slugs of their titles/filenames.

Entries list oldest-first: the wiki is append-only, newest last, so
`limit`/`offset` pages never shift under you. `limit` defaults to 20 and caps
at 100. `search` needs a non-empty `q` (max 200 chars) and matches
case-insensitively across all three planes.

## Notes for implementers

- There is intentionally no write API: wiki entries are appended by the
  merging agent at merge time (`docs/ROOM-WIKI.md` is append-only by rule,
  enforced by `node scripts/check-wiki.mjs`), and procedures change through
  the normal PR process.
- The planes are embedded at build time: `node scripts/wiki-build.mjs`
  parses them into `server/wiki-data.mjs`, which is what the API serves —
  in the Node server, the browser-gate runtime package, and the bundled
  Cloudflare worker alike (the worker has no filesystem, so file reads
  would 503 there). **After changing any wiki plane, run
  `node scripts/wiki-build.mjs` and commit the regenerated
  `server/wiki-data.mjs`.** `node scripts/wiki-build.mjs --check` (part of
  `npm run check`) fails on a stale embed, so the served data cannot drift.
- Contract tests: `tests/wiki-read-api.test.js`. Handler:
  `server/wiki-read-api.mjs` (prefix-delegated from `server/http.mjs`, same
  shape as the growth surface); pure parsers in `server/wiki-parse.mjs`.
