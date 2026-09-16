# Exception register closure

`buildExceptionRegisterClosure` creates an immutable closure bound to exception-register record and disposition hashes. It requires complete exception, condition, control and evidence lineage, separate resolver and reviewer, a valid observed time, and a `resolved`, `expired` or `revoked` outcome. Expired requires the record expiry to have passed. Content and identity PII are rejected; no persistence, messaging or network work occurs.
