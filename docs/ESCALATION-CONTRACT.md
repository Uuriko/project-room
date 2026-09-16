# Escalation contract

`buildEscalationContract` creates an immutable, hash-bound governed scope with nonempty trigger, route and evidence references. Sponsor, owner, approver and reviewer must be separate, and expiry must follow valid-from time. It explicitly excludes room attention, UI, template and work-loop behavior. Content and identity PII are rejected; no external effects occur.
