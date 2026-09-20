# Security reporting

Report vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/Uuriko/project-room/security/advisories/new).
Do not publish exploit details, tokens, private messages or customer data in an
issue or PR. Include the affected revision, a minimal synthetic reproduction,
expected/actual behavior and impact. Coordinate disclosure with the maintainer.
There is no paid bounty or guaranteed response time.

Security fixes target current `main`; older snapshots are not maintained release
lines. Hosted operators must track fixes, test upgrades and maintain backups.
Local development checks are not proof that a public deployment is secure.

If a credential leaks, revoke or rotate it at its provider first, update the
service binding, then verify the old credential is rejected. Deleting a file or
rewriting Git history alone does not revoke a credential. Never include the
credential itself in a report or verification receipt.

For architecture and isolation boundaries, see [SECURITY-MODEL.md](docs/SECURITY-MODEL.md)
and [DATA-BOUNDARIES.md](docs/DATA-BOUNDARIES.md). The [self-host guide](docs/SELF-HOSTING.md)
explains the supported single-node shape and recovery limitations.
