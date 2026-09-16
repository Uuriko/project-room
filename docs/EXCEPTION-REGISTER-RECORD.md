# Exception register record

`buildExceptionRegisterRecord` creates an immutable, time-bounded record bound to a conditional exception-register disposition. Exception and condition references must remain inside evaluated scope, with compensating controls, evidence, and separate owner, approver and reviewer. Non-conditional dispositions, scope escape, missing controls or evidence, role collisions, invalid expiry, content and identity PII are rejected. No persistence, messaging or network work occurs.
