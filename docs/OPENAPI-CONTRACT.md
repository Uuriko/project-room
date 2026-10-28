# OpenAPI Contract Check

`docs/openapi.yaml` is the agent-facing contract for the Project Room HTTP
surface. This page documents the automated check that keeps the document and
the server in agreement — how to run it, what it asserts, and who owns it.

## How to run it

```sh
node scripts/openapi-gen.mjs --check
```

It is also wired into the repo-wide gate as the **Route documentation gate
(batch RT)** step of `node scripts/check.mjs`, and the contract job runs it.

`server/openapi/fragments/` is the edit surface. `scripts/openapi-document.mjs`
concatenates those fragments into the OpenAPI document. `--check` and
`--write` refresh `docs/openapi.yaml` when the rendered bytes differ, then
check the rendering. They do not `git diff` the snapshot.

The check reads three sources of truth and compares them:

| Source | What it provides |
|---|---|
| `server/openapi/fragments/` | the rendered document: every operation key under `paths:` (extracted line-based by `scripts/open-routes.mjs`) |
| `server/routes/table.mjs` (+ legacy routes inventory) | routes the server actually serves |
| `scripts/routes-legacy-allowlist.json` | routes still documented by hand while migration to the table is in flight |

## What it asserts

1. **The document parses** — strict YAML, unique keys. A merge conflict
   left in a fragment fails here first.
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

## Who owns it

The gate was introduced by **batch RT**. The document is now assembled from
`server/openapi/fragments/`. Pull requests edit the fragment for the path
they change. CI regenerates the workspace copy and checks that rendering
against the route table, the legacy allowlist, and the MCP request schemas
(`tests/mcp-openapi-drift.test.js`).

Generating the document from `server/routes/table.mjs` schemas (**RT-final**)
still waits until the legacy allowlist is empty. Until then the fragments
hold the operation text, and the gate still fails if the allowlist is empty.

Related, but separate, checks:

- `node scripts/open-routes.mjs --check` — every `security: []` (open)
  route is named in `docs/ROUTE-AUTH-TABLE.md` and
  `docs/INVITE-ONLY-CHECKLIST.md` §1.
- `tests/mcp-openapi-drift.test.js` — MCP tool input schemas match the
  OpenAPI request schemas for the same logical operations.
- `tests/invite-only-boundary.test.js` — the open-route inventory matches
  what the server actually serves anonymously.

## For editors

Edit the fragment under `server/openapi/fragments/` for the path you are
changing. Then run:

```sh
node scripts/openapi-gen.mjs --write
```

That refreshes `docs/openapi.yaml` and runs the route gate. Commit the
fragment. The snapshot is a published copy; CI checks the rendering against
the routes, not a diff of the snapshot. If the check fails, the fix is in
the fragment, the route table, or the allowlist.
