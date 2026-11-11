# Portable witness continuation checkpoint

The immutable capture qualification remains pinned at `4bc6c411d`. Its 21
Node controls, supported-runtime Worker receipt, runtime binary pin and older
phase failures are unchanged in history. This follow-on adds an unwired
production hash primitive, `server/replay-sha256.mjs`, and executable Node and
actual Worker continuation controls. No service imports it, no schema is
activated, and no serving or event rows are rewritten.

The version-1 serialized state contains eight SHA-256 words, the processed
byte count and at most 63 pending bytes. Encoding is bounded to 1 KiB; each
update accepts at most 256 KiB and the whole witnessed value at most 8 MiB.
Decoding bounds control size before JSON parsing. Future storage callers must
also perform SQL typeof/octet-length admission before materializing the
control, including all binding fields. Update work is proportional to the
new input, with a 64-word schedule and at most one partial block. It never
copies or rehashes the prior prefix. Input state is not mutated.

These bytes are privacy-bearing checkpoint content, including the pending
suffix. They inherit room deletion, backup and restore ownership; they must
not appear in public receipts or diagnostics. The test harness emits byte
counts and comparison booleans, never serialized suffix content.

A hash state is not an authority certificate. A final result must equal the
independent metadata proof captured at H; checkpoint authenticity, capture ID,
room/generation, immutable H/event ID, source epoch, format and exact cursor
position must be checked by the existing replay lifecycle before resumption.
The primitive deliberately cannot assert archive membership or event-source
semantics. Structurally valid state corruption is demonstrated to fail the
independent final digest comparison. No derived self-hash authorizes an old
source, row or checkpoint.

The focused controls pass 48 Node tests: standard empty/abc/long/million-a
SHA-256 vectors; all SHA padding boundaries; byte-wise Unicode and invalid
UTF-8; bounded malformed controls; valid-shape tampering; immutable inputs;
child-process restart of partial blocks; an 8 MiB stream; and the existing
capture/shared-codec/archive trust controls. Four additional captured-H cases
cover body references on/off and archived membership on/off while later posts
and retained-message edits advance the live head. They compare against the
old independent proof, not a new hash invented from the captured value.

The actual supported Worker passes both 2,376,000 and 8,388,608 bytes with two
process restarts during partial hashing and an exact completed-step retry.
The fixture persists its small hash state in test-only Durable Object KV to
exercise serialization and restart. This is not the production checkpoint
proof/epoch implementation or a second task system. Both final digests match
the old proof at H=2; later writes succeed at Muse size. The existing 8 MiB
projection growth refusal remains. The 75.8-second final test duration includes
fixture setup, SQL capture, host and Worker streaming, multiple process
restarts, persistence and host contention; it is not per-step CPU evidence.
The prior separately sampled process measurements remain the resource record.

The first Worker attempt exposed an ArrayBuffer-versus-Buffer fixture bug:
`.length` incorrectly treated a returned SQLite BLOB as empty. Its failure
log is preserved; conversion to `Uint8Array` fixes it. Completed retries skip
another slice lookup, including an unaligned final byte length.

Next production wiring must bind this state to the captured independent proof
and existing replay transaction/receipt, admit a legacy checkpoint without
hydrating the full blob, and emit bounded units through the existing codec.
It must add source-generation mutation fences, preserve immutable prefixes
under appends, validate full independently proved archives, retain explicit
historical replay semantics through restore/checkpoint loss, and perform
independent final parity/publication. The original four red cutover controls
remain acceptance requirements. The shared serving codec is reused in tests;
there is no alternate normalizer or reducer. No final serving certificate or
current production eligibility is claimed.
