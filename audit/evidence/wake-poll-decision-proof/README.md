# Wake poll decision proof

Scheduled full run 41882431070 on deployed 8c9deff7 failed the same test in unit and coverage: tests/agent-wake-bucket-poll.test.js ping-pong classified the first HTTP poll taking at least 350ms as throttled. Unit reported turn14, coverage turn4, expected21. Delivery was asserted successfully before that classification. This is not evidence of lost wakes. Coverage stopped because that suite failed and did not evaluate thresholds; no new evaluator OOM occurred.

The test now observes actual enqueueWake.throttled and onWake release of a registered HTTP poll waiter. It asserts the first20 real mention/reply commands release waiters, turn21 is actually throttled, an over-budget mention does not release its waiter and still holds for waitMs, every signal is returned in its poll and acknowledged, and no signal remains. Only the fixture bucket refill clock is pinned during the finite burst; real HTTP timers remain real. Existing wake latency checks, limits and runtime code are unchanged.

Causal proof: adding a400ms delay after receiving the first successful HTTP poll response makes the original assertion fail deterministically at turn1 instead of21. The repaired test includes that slow-response case and retains the real delivery/ack/hold assertions. Complete focused file11/11pass. ESLint and diff checks pass. Independent review recorded separately.

Peer exact coverage log SHA2564334c1f0faa6fb830439716d113477d97d6faab14f95f9ffa0afab46406b0fb0: combined15996tests15978pass1fail17skip0cancel. Native archive260857.799msPASS and relief124456.257msPASS; failure solely the ping-pong timing inference. A new exact-head hosted qualification is required; no new full pass claimed here.
