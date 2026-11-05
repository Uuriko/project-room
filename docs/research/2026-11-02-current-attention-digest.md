# Conversation attention and bounded native digest

The source chain is `ca091900b` → `cf774eab2` → `e809807b8` → `b04d37f2f` → `dd003d5a0`, based on `a2a4e31b4`. All data is synthetic; no production migration, requests or account changes occurred.

Native conversation attention now excludes formal reply requests from the plain thread-reply class, avoids listing the same agent reply as both mention and reply, preserves the parent post ID, and retains the existing room-DM channel marker. Actual cursor chains deliver eligible late mentions and edited private messages exactly once while excluding deleted messages and private outsider content. Reading does not clear standing obligations. No-cursor reads remain recent-first; explicit catch-up uses opaque continuation across unexamined source pages.

The old digest always hydrated the legacy room and scanned global journal aggregates. Normalized rooms now use existing protected attention/work readers through the same HTTP route and RoomAgentClient method. Contract v2 reports exact global totals as `null`, never zero. `sourceWindow.complete` describes only its declared bounded scope; global attention remains incomplete, with omissions retained. Partial reads keep numeric `next` at the supplied checkpoint. Follow `sourceWindow.nextRead` unchanged, including on empty filtered pages. This continuation binds viewer, credential, room, head and original since; cold service/head changes explicitly require a fresh traversal. The SDK validates scope/continuation/completeness agreement before returning a page.

```js
let next = { since: savedCheckpoint };
for (;;) {
  const page = await client.roomDigest(next);
  inspect(page.attention, page.work);
  if (page.sourceWindow.complete) break;
  next = page.sourceWindow.nextRead;
}
```

V2 responses have an explicit 16 KiB ceiling including the opaque continuation; legacy v1 retains its original 4 KiB/exact-count contract. No global serving record or input cap was raised. Legacy scanner/digest specimens use the existing historical room producer and keep their original completeness/overflow/byte-bound assertions. Conversation-attention tests run both representations. Native equivalents use the real new-room path and actual HTTP/SDK consumption rather than replacing new-room journeys with legacy fixtures.

The event reader now admits a 64 KiB payload prefix before fetching subsequent payloads, preserving the existing single legal event-atom limit of 128 KiB. The excluded candidate is not acknowledged. A twelve-large-message fixture measures the exact source payload getters per page and proves the late ask is delivered once. Catch-up inbox reads also request only posted-message types from the existing event reader, after its bounded source selection. Previously it redacted four work events that it would discard, leaving no record budget for useful work discovery. The canonical nine-assignment control fails before and passes after this narrow change.

Idle inbox equality now compares every decoded authenticated cursor binding/source position and actually consumes both independent random tokens to completion. Both chains examine all thirty messages exactly once, at most four candidates per page; no blob hydration occurs. The active request still reads its protected canonical message. Random ciphertext equality is not a semantic contract.

Qualification: the original requested slice at the base was 5/20 passing; four new canonical controls all fail at that exact base. The composed Node run on `cf774eab2` passes 55/55. After the budget cure, 38 affected inbox/event/work/attention controls pass; the final cursor-only test passes 1/1. ESLint has no errors. The final event-admission spacing change passes secret scanning and has a full-module identical Acorn AST.

Actual Worker SQLite qualification at 1,000 and 5,000 private messages reads the same selected positive tail: warm 303 statements / 1,680 physical rows / zero writes, cold 3,266 rows, unknown counters zero, response 2,302 bytes at both sizes. Warm native-runtime permit observations are zero statements/writes. Returned SQL text is 481,993 / 430,761 bytes including repeated catalog/receipt reads; it is not an aggregate whole-request 256 KiB input claim. Constructor cost is excluded. This does not qualify complete traversal of either private backlog, bound whole recovery/purge cost, or measure CPU. Exact logs, source hashes and scope are in `audit/evidence/current-attention-digest-20261102/receipt.json`.
