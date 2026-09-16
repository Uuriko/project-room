# Consent contract

`buildConsentContract` creates an immutable, hash-bound consent scope with nonempty permissions, restrictions and evidence. Grantor, owner, approver and reviewer must be separate, and expiry must follow the valid-from time. Content and identity PII are rejected. The contract performs no messaging, persistence, runtime or network work.
