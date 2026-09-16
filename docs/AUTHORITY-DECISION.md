# Authority decision

`buildAuthorityDecision` creates an immutable decision bound to an authority contract hash. It requires exact authority, limit and evidence evaluation, separate owner, approver and reviewer, an in-window observation, and an `active`, `conditional` or `denied` outcome. Conditional alone requires condition codes. Content and identity PII are rejected; no external effects occur.
