# Diagnostic privacy and retention boundaries

Local follow-up to `0e65ac5`, isolated identity-scope branch. Canonical Grok
HTTP/MCP files were not edited; integration must preserve those changes.

## Changes

Replaced the heuristic that treated lowercase path segments as safe words.
Only complete known route shapes are retained. Message/invitation IDs become
`:item`, including IDs that look like static route names. Unknown path shapes
collapse to one fixed `:unknown` template, regardless of path length or content.
Query strings never enter the template. The shared helper is used by HTTP
diagnostic recording and console diagnostic output.

Added a distinct-room retention cap to DiagnosticsLog. Defaults are 100 rooms
and 200 records per room: at most 20,000 entries. At capacity, a newly encountered
room evicts the least recently written room. Updating an existing room refreshes
write recency; reading does not. Constructor configuration is validated.

## Verification

12 focused diagnostics/support-export tests passed. New cases cover lowercase
IDs, route-name IDs, encoded values, unknown long paths, query-secret exclusion,
room-prefix isolation, recency eviction, and 2,000 invented room IDs while
checking the configured room bound after every insertion. Existing HTTP tests
retain owner-only support export and templated event routes.
`git diff --check` passed. `node scripts/check.mjs`: 1,157 passed,
zero failed/cancelled/skipped; test duration 29,251 ms.

## Limitations

This is volatile, lossy support history, not enterprise audit retention. Requests
against invented room IDs can evict other rooms' diagnostics; that no longer
grows retained room count without bound. Future durable observability must have
explicit tenant quotas, access controls, retention and deletion policy.

The route allowlist can lag newly added endpoints: those safely collapse to
`:unknown` until reviewed. Unknown route text must never be copied as a fallback.
The test proves entry/room counts, not a heap-byte benchmark. Historical exported
bundles or external logs have not been purged. No deployment or publication was
performed, and broader operational/security qualification remains open.
