# Custody contract

`buildCustodyContract` creates an immutable, hash-bound scope with nonempty asset, control and evidence references. Transferor, custodian, approver and reviewer must be separate, and expiry must follow valid-from time. Content and identity PII are rejected. The contract performs no messaging, persistence, runtime or network work.
