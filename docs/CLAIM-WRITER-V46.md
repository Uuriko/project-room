# Claim writer v46 release boundary

v45 claim decoders discard delegate, approvalHold and planning. An ordinary old note update can erase those fields. v46 adds a versioned fence to work_claims and retains these fields (including project/initiative planning metadata) and their approval/review/lifecycle invariants in the existing state machine. It exposes no new route, scope, key or enabled feature. Accounts, credentials and room history stay in place.

Release the compatible foundation first. Qualify its actual v45-to-v46 Native upgrade and staging smoke, then deploy and smoke production before adding opt-in routes. Subsequent feature releases have this production-verified v46 source as a compatible fallback. Keep the existing admission, schema-floor and smoke gates.

After v46 has written, never roll back to a v45 binary or lower the database marker. Use the qualified v46 foundation or a later qualified v46 package whose canonical readers and state transitions preserve every field in use. Matching a schema number alone is insufficient. An older process must fail closed, including a connection open before upgrade. No restore, identity rotation, grant expansion or history deletion is part of this upgrade.

The upgrade uses the existing startup migration transaction and does not invent a second format or copy room history. The first prior-version open still runs normal eager integrity verification; measured synthetic Native timing is recorded in release evidence and is not a production-scale latency guarantee.
