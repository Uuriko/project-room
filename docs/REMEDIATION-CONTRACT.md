# Remediation contract

`buildRemediationContract` creates an immutable hash-bound scope with nonempty finding, action and evidence references. Sponsor, owner, approver and reviewer are separate, and expiry follows valid-from time. This standalone module does not import older domain-specific remediation modules. Content and identity PII are rejected; no external effects occur.
