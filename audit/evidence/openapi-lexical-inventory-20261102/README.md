# Lexical route matcher inventory

Source `c2dcfe42e4b14975ac0c9296fa431fbd5dadc4f8` based on exact GitHub main `00888c52110d36250d3e07629036701b72926d09`. Only scripts/routes-inventory.mjs and new focused tests change behavior. No HTTP implementation, runtime route registry, documentation paths, baseline, allowlist, gate threshold or dependency changes.

The failure is in static source inference, not scripts/openapi-method-accuracy.mjs itself. On the exact original base the real scratch HTTP method probe already exits 0 for all 569 documented operations. OpenAPI generation/static inventory exits 1 because it invents GET methods on POST-only room routes.

Root cause: indexRegexConsts kept one module-wide name-to-path map. The room regex is named `match`. OAuth GET /oauth/authorize has a local `const match = agentChoices.find(...)` and then `if (match)`. The scanner interpreted that ordinary choice value as every room URL matcher and inherited the enclosing OAuth GET. The trace log records the exact offending source condition and fabricated targets.

The existing scanner now resolves regexp/routePattern matchers and aliases through the lexical declaration at each condition's actual source position. Block/function/parameter/import/destructuring/loop/catch shadows are distinct; URL regex templates still use the existing converter. Nested method gate positions are retained. Imported constant declarations remain syntactically valid during virtual URL substitution; previously global string substitution changed `import { NAME }` into an invalid URL literal binding. Acorn 8.18.0 was already pinned; no new package is added. This is a scoped repair of existing supported matcher patterns, not a new runtime registry or a general interpreter for arbitrary dynamic routing.

Exact original-versus-fixed extraction on unchanged HTTP/source bytes: **906 -> 893 rows**, **zero added rows**, thirteen removed fabricated GET variants. The resulting 893 rows match the unchanged RT-0 inventory exactly. Full delta is in receipt.json.

Causal controls: before 4 tests, 1 pass / 3 fail; after 4/4. One intermediate parser run correctly refused invalid virtual import syntax; that failure is preserved. Neighbor suite: **41 passed / 0 failed / 0 skipped**, including original route-table/auth/OpenAPI/template checks and complete scratch method probe. Both `node scripts/openapi-gen.mjs --check` and `node scripts/routes-inventory.mjs --check` exit 0. Lint/secret scan exit 0.

The actual HTTP control authenticates a disposable room owner before method dispatch: POST activity-read returns 200 with read 0; POST malformed commands returns 422; GET activity-read/commands/import returns 405 method_not_allowed; unknown route returns 404. Thus anonymous 401 responses cannot disguise the fabricated-method regression. Synthetic controls retain valid nested POST matchers, distinct same-named URL regexes, aliases and parameter-shadow negatives. No persistent or production state or credentials are used.

Full commands, source hashes, original/intermediate/final output and compressed-log digests are in receipt.json. Local qualification only; root owns integration/publication.
