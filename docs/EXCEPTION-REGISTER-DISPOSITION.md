# Exception register disposition

`buildExceptionRegisterDisposition` creates an immutable disposition bound to an exception register. It requires complete exception, condition and evidence evaluation, separate owner, approver and reviewer references, and observation inside the register window. Outcomes are `active`, `conditional` or `denied`; non-active outcomes require condition codes. Content and identity PII are rejected, with no persistence, messaging or network work.
