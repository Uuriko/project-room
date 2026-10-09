# Guild-08 suite docs — D03

## public-receipts-room-page-toggle.test.js (1 test)
Fail-first adversarial test (CH-2040 vs QA200-MUT-08): after the owner flips publicReceipts=false, the public room page /r/<slug> hides receipts. Single-test, probes a surface the mutation probes never touched. Honest about its fail-first origin.

## public-work-claim-fence.test.js (4 tests)
Proves the public-work claim fence's crash-safety: cached registry writes can't insert/rewrite/move/delete public-namespace rows; sync failure and thenable rejection roll back; tampered guards or open permits are refused without silent repair; process death mid-transaction recovers original rows and a closed permit. Fence + recovery invariants, no HTTP.

## public-work-claim-finish-journey.test.js (1 test)
End-to-end seeded journey over real HTTP: fresh agent identity claims a public work item, works, finishes, receipt publishes to the public listing. Guards the lifecycle the stranger journey doesn't (in_progress state, done with public receipt). One test, full journey.

## public-work-claims-client.test.js (6 tests)
Proves the owner/public HTTP boundary for outside identities: cold public task to leased outside claim; explicit release returns the task without granting room membership; claim-response redirects can't forward credentials; anonymous recommendations and atomic find-and-claim; bounded matching packets; saved-identity feedback rejects malformed/private pointers. Outside-agent contract.

## public-work-claims.test.js (13 tests)
Proves the public work-claims lifecycle: cold index and path locks without membership; lease expiry/reclaim across generations; immutable receipt hashes; generation-gated resubmission; opt-in/terms/lease/artifact limits; grounded anonymous recommendations; match claims exactly one task; continuation cursors; journal can't impersonate leases; oldest-first relevance; claim conflicts name holder + expiry. The public work surface contract.

## room-activation-pack.test.js (8 tests)
Proves the room activation pack (one machine-readable fetch for agents): pack shape/fields, 404 on unknown room, member roster, open work with claim state, pinned resources, coordination-norm defaults, standard credential funnel, client orientation agrees with browser projection and reads don't advance state. Agent onboarding packet contract.

## room-agent-delegation-client.test.js (2 tests)
Proves membership-administration client methods deliver a real AbortSignal to the transport, and work without a caller signal. Thin transport contract.

## room-agent-paginate.test.js (4 tests)
Proves backward-window message tiling across 100-event boundaries: latest:true delivers every message with no seam skips/duplicates, end bound exclusive, second pages continue cleanly, non-message event mixes tile exactly once. Seam-correctness suite (land-johnstab-1610-gap).

## room-assistant.test.js (15 tests)
Proves the room assistant's revision/membership/host-authority boundaries over real HTTP: durable runs discoverable past 100 terminal requests; two humans share a run; atomic completion with late contributions; channel/thread scoping; explicit conflict/authorized decision/host-confirmed cancellation; private context and unauthorized publishers refused; saved invocation ≠ execution; CSRF on browser sessions; backup roundtrip preserves ownership; disconnect fences execution; MCP discovers scoped coordinator tools. Assistant lifecycle + authority suite.

## room-attachment-quota-ratchet.test.js (4 tests)
Proves quota accounting ignores discarded and expired rows (stage→discard loops can't brick uploads) while still capping live rows, for both room and inbox records. Anti-bricking quota semantics.

## room-attachments-autonomy-tier.test.mjs (4 tests)
Proves the #998 fix: t1_readonly agents can't stage/discard/commit room files (the tier gate now runs inside RoomAttachmentBytes methods); humans and t2 unaffected; owner exempt; guest-agents denied writes but reads stay open. Privilege-boundary regression.

## room-authority.test.js (5 tests)
Proves narrow authority: preserves exact members/provenance/sequence without exposing other room data; legacy/managed/human/account auth no longer needs full room decode; follows the transaction snapshot; malformed projections fail 500 projection_corrupt (not an uncaught TypeError). Authority-scoping + fail-safe suite.

## room-backup-export.test.js (18 tests)
Proves backup/export integrity: exports hash secrets and replay into a fresh store; operator route closed until backup token set; R2/KV daily backup behavior; multi-part KV backups reassemble byte-equal and catch tampering; DO BLOB cells export as base64; manifest versioning; replay skips runtime/retired tables; torn backups fail loudly (including same-count tears via trailer hash); audit report restores drifted projections, strict refuses. Backup honesty suite.
