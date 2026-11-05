# Release CI catalog and chaos qualification

The two clusters in CI41809309288 reproduce at `3824ddcdc79824354e0bcd46c79432a02b5fdf48`: the error catalog lacks `work_approval_pending`, and all three guard-weakened claim modules cannot resolve `board-planning.mjs` from their scratch directory. The bounded run is 15 passing and four failing tests.

The requested current-main base `ac0a9c8e50658a6b2411e60d321c4b12839be78a` already contains both fixes. Commit `d3a78b93de` adds the canonical catalog row and plugin copy; `660fea749c` relocates every local .mjs import in the copied module, preserving real board-planning behavior rather than stubbing it. The original mutation transformations and exactly-once source anchors remain. Both test files are byte-identical between old/new sources, as recorded by their Git blob identities.

On the requested base all19 affected tests pass, including the three controls that must detect deliberately weakened guards. The adjacent release/reclaim fixture suite and canonical/plugin sync check also pass. No additional source fix is warranted; this commit records qualification only.

Commands (Node executable `/Users/johnpotter/.local/bin/node` reports v24.22.1):

```
node --test tests/errors-catalog-drift.test.js tests/chaos/claim-lifecycle-races.test.js
node --test tests/chaos/claim-release-reclaim-races.test.js
node scripts/skills-sync-check.mjs
```

The first command ran on separate detached3824 and ac0a worktrees. No provider, live Room, credentials, restore/schema or old-writer work was exercised. The specifically requested `node24.22.1` filename does not exist on this Mac; the existing `node` executable is that exact version. No dependencies were installed or updated.
