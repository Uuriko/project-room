# Authority contract

`buildAuthorityContract` creates an immutable, hash-bound authority scope with nonempty authority, limit and evidence references. Grantor, owner, approver and reviewer must be separate, and expiry must follow valid-from time. Content and identity PII are rejected. The contract performs no messaging, persistence, runtime or network work.
