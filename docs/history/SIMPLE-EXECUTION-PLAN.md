# Simple execution plan — 19 September 2026

## Outcome

Make the existing room more dependable and easier to maintain. Start from the reviewed 32-commit handoff at c0bb7792, preserving its authorship. This is one bounded implementation cycle, not a redesign or a claim that the larger roadmap is finished.

The product stays focused on people and their agents completing work together without lost context. Existing conversation, membership, work and result models remain the foundation.

## Execution order

1. **Recover pending replies correctly.** Reconcile the small channel-aware recovery change already proposed in PR #698 with this handoff. Keep original command ID, payload, channel and text across reload. Use the existing lost-response browser test and add boundary coverage for channel-bearing stored drafts. Do not merge the unrelated PR changes wholesale.
2. **Consolidate the live asset lists.** Use one pure explicit manifest for Node serving and Worker asset building. Keep the standalone exact-commit packager's historical compatibility tables and independent equality test; making that verifier depend on checkout files would weaken cold recovery. Do not expose new files or infer public assets from all repository files. Verify exact bytes, MIME types, exclusions and packaging.
3. **Make verification dependable.** Reuse PR #582's dedicated root unit job rather than adding a second browser gate. Replace Linux-only timestamp parsing in the board CLI with the already-required jq date parser. Verify existing board fixtures on this Mac. Keep the known oversized HTTP rejection failure separate from unrelated work unless its cause and bounded repair are clear.
4. **Validate the resulting candidate.** Run focused unit and reply/setup browser checks, then the complete root suite, lint, packaging and full browser suite. Record remaining failures honestly. Tests must exercise observable behavior; no skipped assertions to obtain green counts.
5. **Checkpoint and handoff.** Commit the local changes, record exactly what passed and what remains, and release the claim. No publishing/deployment in this cycle.

## Scope limits

No new agent framework, mandatory Second, schema migration, generalized command DSL, notification service or analytics platform. No broad app.js split. These changes should reduce repeated maintenance and fix a demonstrated user failure with minimal new machinery.

## Acceptance

- The lost committed reply survives reload and retry creates exactly one message.
- Channel identity survives repeated persistence/recovery, and malformed or changed payloads cannot acquire a fresh automatic send.
- Live Node/Worker assets have one authored manifest with the same public surface.
- The root unit suite runs in CI with full Git history.
- Existing claims-board tests work on macOS without GNU date.
- Results include unresolved failures rather than calling a partial suite release-ready.

## Following cycle

Use the integrated evidence to prioritize remaining browser failures, especially catch-up and return. Then observe a real human/agent contribution-and-return journey before changing navigation or adding features. The broader proposal is /Users/johnpotter/src/PROJECT-ROOM-PRODUCT-ARCHITECTURE-2026-09-19.md.
