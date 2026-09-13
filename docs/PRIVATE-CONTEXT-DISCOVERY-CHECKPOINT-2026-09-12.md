# Private context discovery checkpoint

Exact checkpoint `af2ee88`: full Node regression 1,512/1,512 passed, zero failures or skips. Focused discovery/read/grant checks passed before the owner-revision extension; the final full run includes that extension and corrected fixture.

Runtime `d571177`, test corrections `af2ee88`. The server now supports `GET /api/rooms/:roomId/private-context` for authenticated agent recipients. A response contains up to 25 `{grantId, expiresAt, permissions}` entries, room/viewer metadata, and a `next` share ID or null. It contains no share body, source/account identifiers, sender, subject or Inbox text.

Pass `before=<next>` to continue. The marker must itself still be a currently authorized share; foreign, expired or revoked markers fail rather than reveal a journal position. Restart without a marker after that failure. This is a live listing, not a frozen snapshot: new grants appear on a fresh first page; revocations and authority changes apply immediately.

SQL selects current recipient revision, active owner account/epoch, current owner binding/revision and unrevoked/unexpired grants. Every returned entry also passes the existing authoritative `readGrant` check inside the same read transaction. Reads create no room events. Humans retain existing owner controls and exact-share reads; this new discovery endpoint is agent-only.

Acceptance covers multiple pages, unrelated recipients, empty-after-membership-change, owner revision changes, expiry, revoked/foreign markers, duplicate/unknown query fields, method restrictions and no-store responses. The corrected fixture preserves required owner administration and renews credentials after its simulated expiry check.

Known limits: output and per-page follow-up checks are bounded, but the JSON journal query is not an indexed recipient projection. Large-journal load profiling and a migration-safe index/projection strategy remain necessary before enterprise scale claims. Client/MCP listing and human-visible share pointers remain unfinished. The exact-share agent reader is already available separately. No private content is automatically acted on or posted into room history. Independent review requested; no live activation.
