# Stewardship decision

`buildStewardshipDecision` creates an immutable decision bound to a stewardship contract hash. It requires exact asset, duty and evidence evaluation, separate steward, approver and reviewer, an in-window observation, and an `active`, `conditional` or `denied` outcome. Conditional alone requires condition codes. Content and identity PII are rejected; no external effects occur.
