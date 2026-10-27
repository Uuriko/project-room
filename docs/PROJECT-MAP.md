# Project map

Use revision-pinned maps to find dependencies and possible overlapping work. Maps
are advisory evidence: read the code and run tests. They do not prove behavioral
equivalence, safety, or permission to act.

`parser` is Room's lightweight JavaScript parser. `graphify` is an explicit import
from [Graphify](https://github.com/Graphify-Labs/graphify), Apache-2.0. Engines are
labeled separately and never silently substituted.

## Local use

From a maintained checkout:

```sh
npm run map:local -- setup
npm run map:local -- build --repo Uuriko/project-room --checkout . --revision origin/main --scope server --compact --out /tmp/room-server-map.json
npm run map:local -- query /tmp/room-server-map.json server/work-claims.mjs
npm run map:local -- explain /tmp/room-server-map.json server/room-export.mjs
npm run map:local -- path /tmp/room-server-map.json server/restore-ndjson.mjs server/store.mjs
npm run map:local -- hotspots /tmp/room-server-map.json
```

Setup explicitly downloads `graphifyy==0.9.96` (two y's) into an isolated cached
Python3.12 environment using uv. Transitive dependencies are resolver-selected;
this is operator tooling, not a vendored server dependency. Builds materialize
supported committed source blobs at the resolved SHA, excluding symlinks,
dirty/untracked files, hidden/config files and private lanes. Extraction uses
code-only/no-cluster mode, no model backend, empty HOME, stripped provider
credentials and a Python socket-connect deny guard.

Scope limits coverage to a file/directory. Omit it for supported committed source
across the repository. Compact mode retains all nodes and every relationship Room
consumes while removing unused attributes and relationships. Original digest,
source scope, manifest hash and revision stay in the envelope. This is explicitly
a files/symbols/imports/calls projection, not Graphify's full semantic graph.
Large graphs can exceed hosted limits; use local queries or an explicit scope.
Missing results on a scoped/truncated map do not prove absence of dependencies.

Rebuild at the intended new commit to refresh. There is currently no automatic
GitHub push hook or PR-file synchronizer. A successful local build is not a hosted
update. Check revision before using a map for a current change.

## Publish and query in Room

Set ROOM_AGENT_CONFIG to the existing private saved-connection directory:

```sh
npm run map:publish -- --envelope /tmp/room-server-map.json
```

Publication verifies the expected member, reads current map revision and graph digest, sends both
as its conflict-check basis and checks the graph digest on readback. Lost responses are reconciled by
reading, without blind repetition. Conflicts require a new explicit decision.
Credentials never belong in command arguments or graph artifacts.

Discover authenticated `room_map` using `room_search_actions` with `map hotspots`.
It supports query, path, hotspots and explain; it is not in the lean/core default
list. REST reads are:

- GET /api/rooms/{roomId}/map/query?q=&repo=
- GET /api/rooms/{roomId}/map/path?from=&to=&repo=
- GET /api/rooms/{roomId}/map/hotspots?repo=
- GET /api/rooms/{roomId}/map/explain?q=&repo=

Results carry revision, engine, build time, truncation and provenance. The server
verifies envelope binding, not the uploader's Git checkout; revisionVerified:false
states that distinction. The local build records its independently resolved SHA.

POST /api/rooms/{roomId}/map accepts repo, revision, expectedRevision, expectedGraphSha256 and
`graphify:{repo,revision,graph}`. The parser accepts files:[{path,source}], removed,
and optional replace instead. Send the last read revision and provenance.graphSha256; use null for each absent value on first publication. The digest catches different graph scopes or content built from the same Git revision. These fields remain optional for manual callers; the publisher always sends both.
Updates allow 200 source files, 64 KiB each and 4000 removals. HTTP uploads and stored
graphs are bounded at 1,500,000 bytes. Invalid updates preserve the previous graph;
truncation is explicit rather than silently reported as complete.

Writes require current owner/manage_claims/steer authority, permitted autonomy
and API-key scope where applicable. Authority is rechecked after body arrival.
Ordinary members retain read access. Maps are included in personal-room deletion
and operator room purge. They are derived, rebuildable data.

## Overlap

Claim responses and Board disclosures compare known file/symbol sets in the same
explicit repository. The SDK preserves repo and branch on create/claim/reclaim.
POST /api/rooms/{roomId}/map/pulls records observed PR file sets and open/closed/
merged state; the publisher must keep those observations fresh.

Common generated/catalog files are excluded from file similarity. Jaccard>=0.7,
or a subset of at least two files, yields a possible-duplicate advisory. Inspect
actual diffs, stack relationships and observation age. Notices do not block work
or grant authority.

## Activation and rollback

ROOM_PROJECT_MAP defaults on; off disables builds, queries and notices.
ROOM_PROJECT_MAP_GRAPHIFY defaults off. Graphify intake also requires a matching
ROOM_PROJECT_MAP_REPO. This repository's Worker configuration enables intake for
Uuriko/project-room; deployment and readback still must succeed. Other installations
opt in explicitly. Old local checkout/output path variables are unused: no Python,
filesystem graph read or subprocess runs inside a Room request or Worker.

Disable Graphify intake, or the entire map, to stop use. Preserve the prior graph
for diagnosis. Rebuild from the intended exact revision before enabling stale data.
