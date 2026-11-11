# Existing connection audit on normalized rooms

Standalone runtime `3644200b6`, red reproduction `4f5226844`, base `a8729b406`. This patch changes only the existing connection verifier's current membership, owner and sequence reads to protected addressed `roomAuthority` reads. It retains all original journal, credential, ownership and v2 full historical replay checks.

The causal test creates real owner-sponsored and friend-sponsored connections plus an accepted human invitation, activates normalized serving using the existing H fixture, and cold-reopens a file database. Before the fix the verifier fails with “Use an addressed current Room read.” Afterward, active connections and existing OAuth refresh work as the same members; revoked and expired friend connections remain refused. Connection rows, operation journals, account links, identity links, credentials and invitation journals remain exact. Accepted invitation account authentication and the original full recovery audit pass. Instrumented corrupted original membership evidence and historical sponsor permissions still refuse.

Thirty-three affected controls passed before the final addressed-read refinement; nine focused ownership/timestamp and normalized controls passed after it. These counts overlap. No whole-room hydration is used by the repaired verifier.

This fixture qualifies an existing normalized state; it does not qualify the new content-reset route or make H conversion a release requirement. No Worker, live account, real provider, deployment, reset or separate adoption-auth changes are claimed.
