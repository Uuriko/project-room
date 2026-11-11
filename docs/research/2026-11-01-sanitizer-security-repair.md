# Shipped Gmail sanitizer security repair

The root dependency audit reported six affected dependency records (five moderate and one low), not six independent vulnerabilities. Although sanitize-html is a development dependency, its generated sanitizer is shipped and imported by server/gmail-content.mjs. This repair pins sanitize-html 2.18.1, regenerates that bundle and its license inventory, and moves the minimatch override to 11.0.1. Sanitizer 2.18.1 removes its deepmerge dependency; this does not imply an upstream deepmerge fix.

Two regressions fail against the original shipped bundle: 4,000 unclosed iframe elements throw a RangeError through the actual Gmail policy, and discarded iframe nesting exceeds an explicit nestingLimit. Both pass against the regenerated bundle. The Worker check executes the shipped policy and checks preserved safe formatting and links.

Validation on Node 24.22.1: 91 focused consumer tests pass; seven Worker checks pass; lint finishes with zero errors and 336 warnings. Root-lock npm audit reports zero findings after the repair. Preflight passes. These results do not assert that every application dependency or vulnerability is covered by the root audit. The minimatch major override was exercised by actual repository lint rather than accepting npm's suggested ESLint downgrade.

No production account, permission, scheduler or grant changes are included. Source qualification, integration, deployment and live verification remain separate.

Primary advisories:
- https://github.com/advisories/GHSA-c9rx-x947-fp3h
- https://github.com/advisories/GHSA-g3hv-75wg-m249
- https://github.com/advisories/GHSA-gcqx-w48m-w2h4
