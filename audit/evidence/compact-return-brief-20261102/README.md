# Compact native result rendering

The regression uses the actual `thinWorkForContext` producer and `currentResult` selector, then executes the production `resultRow` function extracted with Acorn. On main ff09101bd the compact native receipt omits summary and nativeText: rendering throws `item.receipt.summary is not iterable` (1 pass, 1 fail). The initial top-level-only function extraction failed before executing the regression; it was corrected to recursive AST lookup before the valid baseline recorded here.

The fix renders Saved result and the existing selected Read result control for compact receipts. It does not invent result prose, replace evidence identity, classify unknown compact results as external, or fetch history. Full native/external receipts and Unicode truncation retain their behavior. The existing selected result reader loads the full evidence on demand.

`node --test tests/compact-return-brief.test.mjs`: 2 pass, 0 fail, 0 skip, exit 0. ESLint, secret diff scan and diff check each exit 0. This is a production-function regression with the real compact representation, not an actual browser rerun or proof of the whole login journey. Root owns manifest generation, integration and browser confirmation.
