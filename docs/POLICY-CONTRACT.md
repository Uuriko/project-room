# Policy contract

`buildPolicyContract` creates an immutable, time-bounded policy among opaque sponsor, operator and steward references. It requires policy, constraint and evidence references plus separate approver and reviewer. Empty scope, role collisions, invalid windows, content and identity PII are rejected. It performs no persistence, messaging or network work.
