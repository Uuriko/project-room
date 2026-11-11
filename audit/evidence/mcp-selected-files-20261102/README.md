# Selected hosted files and history-scoped downloads

Source: `b4f72b485280481b4f3ec88a396d320f168f842e`, based on `d45ed5373`. Adoption order: `7a853d049`, `4842bbfc0`, `b4f72b485`. This evidence is local qualification, not integration, deployment or live verification.

The MCP adapter now forwards selected message IDs and continuation to the existing bounded file service. Its schema accepts one to eight unique IDs; cursor requires selection. Legacy unselected listing remains compatible. Normalized listing omits staged inventory and follows empty-more pages rather than treating empty as complete. OpenAPI source fragments and hosted contracts describe the actual limits.

The causal security red proved a late since-join member could GET bytes by known attachment ID even though selected listing correctly refused the prejoin message. The cure loads the protected bound message and history floor before selecting bytes; DM checks remain. A request-local message cache avoids duplicate proof hydration within this one read. Unbound staging stays uploader-only. Direct service, actual HTTP and hosted MCP tests cover since-join denial, explicit all-history nonowner access and owner unlimited history. Refusals match an unknown attachment. Missing independent message proof fails closed.

Saved-action controls exercise a real dropped HTTP acknowledgement for stage and commit, exact retry, and injected failed commit rollback. Paging covers nine attachments, cursor selection/viewer binding and a discarded first page that is empty but has more. Original orphan assertions remain in one explicitly historical compatibility fixture; new product rooms stay normalized.

Commands (all run from this tree with `/Users/johnpotter/.local/bin/node`):

- `node --test tests/room-mcp-files.test.js tests/mcp-tool-contracts.test.js tests/mcp-tools-reconciliation.test.js tests/current-browser-attachments.test.mjs`: 33 pass, zero fail/skip, exit 0.
- `node --test cloudflare/current-attachment-history.check.mjs`: one pass, zero skip, exit 0. Actual default July Native SQLite, dispose then cold restart; denies prejoin/private/other-uploader staging/unknown IDs before payload SELECT, then verifies fresh and owner downloads. This is the shared service on Native; hosted HTTP/MCP wrappers are qualified separately by the Node server tests.
- ESLint on the seven source/test files in receipt.json: exit 0.
- `node scripts/openapi-gen.mjs --check`: exit 0; snapshot regenerated from fragments.
- `node scripts/secret-scan-diff.mjs --base d45ed5373`: clean, exit 0.
- `git diff --check`: exit 0 before commit.

Preserved failures: baseline seven tests had five failures; new adapter schema red and actual prejoin bytes-leak red are archived. Neighbor core profile had four inherited failures (bond response contracts and retired legacy claim fixture setup) after the owned ratchet was fixed. A separate 38-test run had one stale account-deletion lifecycle assertion owned by the bounded helper; it was not removed or counted green. No global suite claim, physical storage cost claim, account reset or production call was made.

Each compressed log has the original complete uncompressed SHA-256 and observed exit status in receipt.json. Empty successful lint/generation logs are intentional. The Native fixture is synthetic and uses no real credentials.
