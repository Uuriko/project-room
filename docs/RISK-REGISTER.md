# Risk register

`buildRiskRegister` creates an immutable, time-bounded risk register among opaque sponsor, owner and steward references. It requires risk, mitigation and evidence references plus separate approver and reviewer. Empty scope, role collisions, invalid windows, content and identity PII are rejected. It performs no persistence, messaging or network work.
