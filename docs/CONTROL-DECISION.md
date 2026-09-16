# Control decision

`buildControlDecision` creates an immutable decision bound to a control. It requires complete control, safeguard and evidence evaluation, separate operator, approver and reviewer references, and observation inside the control window. Outcomes are `active`, `conditional` or `denied`; non-active outcomes require condition codes. Content and identity PII are rejected, with no persistence, messaging or network work.
