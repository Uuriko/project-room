# Custody decision

`buildCustodyDecision` creates an immutable decision bound to a custody contract hash. It requires exact asset, control and evidence evaluation, separate custodian, approver and reviewer, an in-window observation, and an `active`, `conditional` or `denied` outcome. Conditional alone requires condition codes. Content and identity PII are rejected; no external effects occur.
