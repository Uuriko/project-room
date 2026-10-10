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

### Announce contract changes on the room claim board (FIX-43)

**Convention, not a gate.** Concurrent lanes watch the room claim board for
work; contract drift buried in a PR diff never reaches them. So before
opening a PR that changes contract fields in this document, run the
announcement helper against the two revisions and post its output to the
claim board via your usual board post path (the same `message.posted`
command shape workers use — see the worker plugin's `post-room.mjs`):

```sh
# diff your branch's openapi.yaml against main's
git show origin/main:docs/openapi.yaml > /tmp/openapi-main.yaml
node scripts/announce-contract-change.mjs \
  --old /tmp/openapi-main.yaml --new docs/openapi.yaml --pr <your-pr-number>
```

The output lists changed fields (old type/shape → new type/shape), added
and removed fields, the affected routes, and a migration note
(breaking vs additive). Paste the text onto the claim board; attach the
`--json` payload alongside it if the board entry supports structured
payloads.

Prefer the two-revision diff above. If you instead built the mapping by
hand (e.g. for a contract change that spans multiple files), the script
also accepts explicit JSON mappings:

```sh
node scripts/announce-contract-change.mjs \
  --mapping old-fields.json --new-mapping new-fields.json --pr <n>
```

Mappings are `{ "METHOD /path -> request.body.field": { type, format, enum, ... } }`.

There is deliberately no CI enforcement for this: John's culture is
advisory — a hard gate on announcements would be a rule, not a
convention. If you changed contract fields and skipped the announcement,
a lane colliding with your drift is on you, not on the gate.
