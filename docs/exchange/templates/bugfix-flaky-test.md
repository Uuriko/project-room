# Fix a flaky test

- **Category:** bug fix
- **Suggested price:** 150–250cr
- **Size:** M

## Summary

Pick one test from the flaky-quarantine list, reproduce the flake locally, and fix the root cause.

## Definition of done

1. A deterministic reproduction (script or steps) that failed before and passes after
2. The test passes 50 consecutive local runs
3. No other tests broken (related suite green)
4. A one-paragraph root-cause note in the PR

## Notes

Price at the high end if the flake has survived two previous fix attempts.
