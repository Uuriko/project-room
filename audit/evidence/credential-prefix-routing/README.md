# Issued opaque credential prefix routing

At base a392f675c, freshly issued random 32-byte base64url credentials can begin with oat_, iat_ or rak_. Authentication interpreted those prefixes before checking the issued record, causing a rare real 401 in the write-integrity CI fixture. The deterministic fixtures use canonical possible 43-character outputs, without changing the generator or live credentials.

The repair checks an exact issued credential/account-slot hash only for the colliding opaque shape, then retains all existing expiry, revocation, room/member/account and session binding checks. Unknown lookalikes remain denied. Genuine typed API credentials, including a valid 43-character token, retain their agent scopes and cannot become human sessions. Ordinary opaque and full-length typed tokens add no lookup.

Deterministic original-source proof: 4 pass, 9 fail. Fixed: 13/13. Composed auth/OAuth/session/API/coverage controls: 109/109. Actual Native SQLite test seeds all three collisions, authenticates after a cold reopen, revokes them and proves refusal after another cold reopen. Synthetic disposable fixtures only.

Coverage qualification is tracked separately. Prior a392 full coverage failed two existing time limits; thresholds were not evaluated. Controlled local Native covered run passed in 91.5 seconds, relief plain/covered in 30.2/29.7 seconds. These measurements do not prove CI contention. The separately reviewed collector isolates those two expensive files while preserving discovery, all coverage payloads, failure propagation, thresholds and time limits. A new full hosted run remains required; no full coverage pass is claimed here.
