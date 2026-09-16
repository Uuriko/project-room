# Custody resolution

`buildCustodyResolution` creates an immutable resolution bound to custody exception and decision hashes. It requires complete asset, control, safeguard and evidence lineage, separate resolver and reviewer, a valid observed time, and a resolved, expired or revoked outcome. Expired requires exception expiry to have passed. Content and identity PII are rejected; no external effects occur.
