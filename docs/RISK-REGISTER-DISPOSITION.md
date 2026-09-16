# Risk register disposition

`buildRiskRegisterDisposition` creates an immutable disposition bound to a risk register. It requires complete risk, mitigation and evidence evaluation, separate owner, approver and reviewer references, and observation inside the register window. Outcomes are `active`, `conditional` or `denied`; non-active outcomes require condition codes. Content and identity PII are rejected, with no persistence, messaging or network work.
