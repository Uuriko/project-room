# Risk register closure

`buildRiskRegisterClosure` creates an immutable closure bound to risk-register exception and disposition hashes. It requires complete risk, mitigation, control and evidence lineage, separate resolver and reviewer, a valid observed time, and a `resolved`, `expired` or `revoked` outcome. Expired requires the exception expiry to have passed. Content and identity PII are rejected; no persistence, messaging or network work occurs.
