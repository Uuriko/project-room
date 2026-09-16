# Risk register exception

`buildRiskRegisterException` creates an immutable, time-bounded exception bound to a conditional risk-register disposition. Risk and mitigation references must remain inside evaluated scope, with compensating controls, evidence, and separate owner, approver and reviewer. Non-conditional dispositions, scope escape, missing controls or evidence, role collisions, invalid expiry, content and identity PII are rejected. No persistence, messaging or network work occurs.
