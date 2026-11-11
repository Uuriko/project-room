# Advertised A2A receipt specification URI

The live-advertised URI was absent at production base `328928e275e05b950b8f4e7bd6ec9bcf42cc03f5`. New focused tests first fail 0/2 (no discovery doc, HTTP 404). The current canonical A2A document defines an optional declarative project-room-receipt/1 convention, not an RPC implementation or a claim of signed public receipt issuance.

Existing open PR #4534 at c18ab337cf2d70b8328994ec74d5977b5a9d7415 already proposed a shared discovery-doc route. Its receipt summary incorrectly called public-work-receipt/1 signed. This narrow adoption credits that route approach, corrects its text against docs/a2a-receipt-extension.md, and leaves all unrelated skill/onboarding changes unadopted. No new module, schema, grants or capability implementation.

Source 9418fd269 serves a short Markdown specification and existing canonical full-doc link at GET/HEAD /extensions/work-receipt/v1. Node uses actual modern route rows; the edge uses the same doc bytes without Durable Object access. OpenAPI and both public route inventories are registered; the legacy baseline is unchanged. Unknown v2 remains unavailable. Public receipt records are explicitly described as unsigned project-room-public-receipt/1.

57 focused Node tests and two actual default Native edge tests pass, zero skips. Native verifies GET/HEAD plus POST 405 and zero DO/job access. Route docs, public route inventory, manifest check, lint and diff checks pass. CI-mode contract exits 0 on final source 3709d759e (15 contract tests; full unit suite intentionally not rerun).

Root authorized a separate inherited QA secret-scanner false-positive cure. Formatting-only commits split the runtime token member-expression across lines; Acorn AST matches the exact original script. The first formatting pass alone still scanned red; final spacing yields scanner exit 0 without exemptions or semantic changes. The QA script was not executed against staging or production. No deployment or live verification by this helper.
