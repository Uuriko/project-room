# Remediation exception

`buildRemediationException` creates an immutable exception bound to a conditional remediation decision. Finding and action scopes stay contained; compensating controls and evidence are required. Roles are separate and expiry is bounded. It imports no older domain remediation modules and has no external effects.
