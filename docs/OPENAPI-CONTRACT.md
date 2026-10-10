# OpenAPI Contract Check

`docs/openapi.yaml` is the agent-facing contract for the Project Room HTTP
surface. This page documents the automated check that keeps the document and
the server in agreement — how to run it, what it asserts, and who owns it.

## How to run it

```sh
node scripts/openapi-gen.mjs --check
```

It is also wired into the repo-wide gate as the **Route documentation gate
(batch RT)** step of `node scripts/check.mjs`, and runs in CI on every PR.

The check reads three sources of truth and compares them:

| Source | What it provides |
|---|---|
| `docs/openapi.yaml` | every operation key under `paths:` (extracted line-based by `scripts/open-routes.mjs`) |
| `server/routes/table.mjs` (+ legacy routes inventory) | routes the server actually serves |
| `scripts/routes-legacy-allowlist.json` | routes still documented by hand while migration to the table is in flight |

## What it asserts

1. **The document parses** — strict YAML, unique keys. A merge conflict
   left in the file fails here first.
2. **Template gate** (`routeDocsDrift`) — every served route template must be
   documented, and the document must not describe a route the server no
   longer serves. Path parameters are normalized (`{id}`, `:id` → `{}`) so
   the two sides compare equal.
3. **Method coverage** — every documented operation must be a row in
   `server/routes/table.mjs` or a row still listed in the legacy allowlist.
   (A documented `HEAD` is covered when `GET` is served for the same
   template.)

Output on success:

```
OpenAPI route gate: document parses, and every documented operation is served.
```

On failure it prints one `OpenAPI route gate:` line per problem and exits
non-zero. A documented operation the server does not serve shows up as
`documented operation is not in the route table or the legacy allowlist`.

## What the numbers mean

The check is **count-independent** — there is no hardcoded route total.
"515/515 with 0 mismatches" means every documented operation was matched to
a served route; the document currently holds 515 operations and the count
moves as routes are added or removed. Do not pin a fixed number in
runbooks: older notes said "512/512", which went stale. Trust the check
output, not the number.

## The served spec is a curated surface (qa7-03)

`GET /openapi.json` is generated from `DISCOVERABILITY_ROUTES`
(`server/discoverability.mjs`): a hand-maintained inventory of the in-scope
**machine** surfaces, deliberately not the full route table. The exclusions
in `scripts/openapi-served-exclusions.json` are intentional scope decisions
(human web-UI backends, account auth, operator console, and similar), each
with a written reason — they are not documentation debt and the curated
surface is the design (qa7-03 ruling, 2026-10: KEEP).

`tests/openapi-served-coverage.test.js` enforces both directions: no phantom
paths in the served spec, and no silent omissions — a new served `/api`
route fails CI until it is either inventoried in
`server/discoverability.mjs` or added to the exclusion file with a reason,
and a stale exclusion prefix that matches nothing fails CI too.

## Who owns it

The gate was introduced by **batch RT**. It stays a check (not a
generator) until the legacy allowlist is empty; when it is, byte-for-byte
generation of `docs/openapi.yaml` from the route table begins (**RT-final**),
because hand edits and generation would fight over the document.

Related, but separate, checks:

- `node scripts/open-routes.mjs --check` — every `security: []` (open)
  route is named in `docs/ROUTE-AUTH-TABLE.md` and
  `docs/INVITE-ONLY-CHECKLIST.md` §1.
- `tests/mcp-openapi-drift.test.js` — MCP tool input schemas match the
  OpenAPI request schemas for the same logical operations.
- `tests/invite-only-boundary.test.js` — the open-route inventory matches
  what the server actually serves anonymously.

## For editors of `docs/openapi.yaml`

Run the check before you push. If it fails after your edit, the fix is in
your edit (documented-but-unserved, unserved-but-undocumented, or a parse
error) — not in the checker. The checker changes only when the route table
or the allowlist genuinely moved; if you suspect that, re-run the check
against `origin/main` first to isolate it.
