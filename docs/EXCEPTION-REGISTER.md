# Exception register

`buildExceptionRegister` creates an immutable, time-bounded exception register among opaque sponsor, owner and steward references. It requires exception, condition and evidence references plus separate approver and reviewer. Empty scope, role collisions, invalid windows, content and identity PII are rejected. It performs no persistence, messaging or network work.
