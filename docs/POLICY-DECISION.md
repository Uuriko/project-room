# Policy decision

`buildPolicyDecision` creates an immutable decision bound to a policy. It requires complete policy, constraint and evidence evaluation, separate operator, approver and reviewer references, and observation inside the policy window. Outcomes are `active`, `conditional` or `denied`; non-active outcomes require condition codes. Content and identity PII are rejected, with no persistence, messaging or network work.
