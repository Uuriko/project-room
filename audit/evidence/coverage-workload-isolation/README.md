# Coverage workload isolation

Source ddd1dfc8767cdf0f47814cede7390107fb1f78c5 on exact a392. Existing collector/evaluator retained. Two expensive files run each alone, then remaining discovered tests run with normal concurrency. One coverage directory is cleared once and all batches contribute; any batch failure fails the gate after remaining batches complete.

The original collector fails the new deterministic runner-separation control (one runner versus three); revised collector passes all 20 tests, including 17 existing guards. Real fixture V8 coverage proves earlier batches survive. ESLint and diff checks pass. See qualification.json for commands and limits. No claim that CI contention caused the observed timeouts; no full suite or production execution.
