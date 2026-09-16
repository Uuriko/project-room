# Approval contract

`buildApprovalContract` creates an immutable hash-bound scope with nonempty request, criterion and evidence references. Sponsor, owner, approver and reviewer are separate, and expiry follows valid-from time. It imports no existing prefixed approval modules. Content and identity PII are rejected; no external effects occur.
