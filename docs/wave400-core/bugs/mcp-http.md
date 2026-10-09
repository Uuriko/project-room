# Suspected bugs — server/mcp-http.mjs

Flagged, not fixed. All in `server/mcp-http.mjs`.

- `:dispatchRoomMcp` — when `roomMcp` is not a function and a credential *is* presented, the reply id validation duplicates `handleMcpJoinRpc`'s logic inline; if they ever diverge, authenticated errors could carry a different id policy than anonymous ones.
- `:roomMcpFetchResponse` + `:writeRoomMcpNode` — two hand-synced implementations of the same GET/HEAD/OPTIONS/POST surface; any future change to one (e.g. a new header) must be mirrored in the other, with no shared helper enforcing it.
- `:handleMcpJoinRpc` — `tools/call` with `message.params` non-object: `message.params?.name` is undefined → falls to the unknown-tool path with `tool: undefined`; the error names no tool, which is fine, but `closestToolName(undefined, …)` behavior is untested.

Checked and clear: version negotiation transparency (#1529), hosted-name suggestion suppression (#1528), empty-Bearer carve-out, RFC 7235 case-insensitivity, 401 WWW-Authenticate, notification → 202.
