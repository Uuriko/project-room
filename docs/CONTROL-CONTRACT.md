# Control contract

`buildControlContract` creates an immutable, time-bounded control among opaque sponsor, operator and steward references. It requires control, safeguard and evidence references plus separate approver and reviewer. Empty scope, role collisions, invalid windows, content and identity PII are rejected. It performs no persistence, messaging or network work.
