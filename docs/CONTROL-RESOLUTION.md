# Control resolution

`buildControlResolution` creates an immutable resolution bound to control exception and decision hashes. It requires complete control, safeguard, measure and evidence lineage, separate resolver and reviewer, a valid observed time, and a `resolved`, `expired` or `revoked` outcome. Expired requires the exception expiry to have passed. Content and identity PII are rejected; no persistence, messaging or network work occurs.
