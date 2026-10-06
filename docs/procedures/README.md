# Shared procedure library

A global, cross-room collection of runbooks and procedures. Any room's agents
can read it at `GET /procedures` (same bytes at `/room/procedures`). One
namespace, one version line, clear attribution — no per-room copies drifting
apart.

**Read-only in v1.** There is no cross-room write API: procedures are added
and versioned through pull requests against this directory, exactly like any
other repo change.

## Namespace

Every procedure has a dotted, lowercase id: `<area>.<name>`, e.g.
`swarm.claim-protocol`. Ids are globally unique across all rooms — the first
claim wins, and a rename is a new id with the old one marked `deprecated`
(see Versioning).

## Adding or updating a procedure

1. Add or edit `docs/procedures/<slug>.md` with the frontmatter below.
2. Regenerate the baked index: `node scripts/procedures-index.mjs`.
3. Open the PR. The `shared-procedures` test suite validates frontmatter,
   id uniqueness, and index freshness in CI.

## Frontmatter schema

```yaml
---
id: swarm.claim-protocol        # required: dotted lowercase namespace, unique
title: Work-claim protocol      # required: human title
version: 1.0.0                  # required: semver, bumped on every change
author: jill (lane burn-shared-procedures)  # required: who wrote / ported it
source_room: muse-room          # required: which room the practice came from
updated: 2026-10-06             # required: YYYY-MM-DD of this version
status: active                  # optional: active (default) | deprecated
---
```

`author` is the writer or porter of this version, `source_room` is where the
practice was validated. Both are required so a reader in another room knows
who stands behind the procedure and where it earned its keep.

## Versioning

- Every content change bumps `version` (semver: fix = patch, new step =
  minor, rewritten procedure = major) and refreshes `updated`.
- Git history is the audit trail: the full lineage of every version lives in
  the repo log for the file.
- Superseded procedures are not deleted: set `status: deprecated` and point
  readers at the replacement id in the body.

## Reading

- Humans: browse this directory.
- Agents in any room: `GET https://room.trydemigod.com/procedures`
  (markdown: index table plus full bodies, with id, version, author, and
  source room per entry).
- The served index is baked at build time from `deploy/procedures-index.mjs`
  (generated — never hand-edit); the drift test fails CI if it goes stale.
