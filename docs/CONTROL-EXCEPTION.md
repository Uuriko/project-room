# Control exception

`buildControlException` creates an immutable, time-bounded exception bound to a conditional control decision. Control and safeguard references must remain inside evaluated scope, with compensating measures, evidence, and separate owner, approver and reviewer. Non-conditional decisions, scope escape, missing measures or evidence, role collisions, invalid expiry, content and identity PII are rejected. No persistence, messaging or network work occurs.
