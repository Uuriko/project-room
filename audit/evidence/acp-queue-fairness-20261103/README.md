# ACP waiting-thread fairness

Source `443b82b7197c26734c60f20b8d5c2bbc55b2f01d` on exact main `5c83d57138d64680a7f704d6dfc7cdfd661285d3`.

One scheduling statement moves after the oldest waiting thread is scheduled. Previously a just-completed thread reclaimed its slot whenever new inputs had accumulated; four continuously refilled roots could delay an independent already-routed question. The freed slot now goes to the oldest waiting thread, then the completing thread's next batch joins the waiting order. No active turn is preempted. Same-thread serialization, concurrency and batch ownership remain unchanged.

The bounded causal test fills four execution slots, continuously refills each historical root for four finite rounds, then routes a fifth question. Before the fix, the next started batch belongs to old-0; after, it belongs to fresh. The test verifies all 17 original/refilled inputs run exactly once, no same-thread overlap, and peak concurrency four. Other controls preserve FIFO waiting order, batching, and waiting/same-thread input retention after a thrown execution error. Formal and uncertain inputs are scheduling examples, not reclassified or acknowledged by the queue.

Before: all three focused controls fail. After: 77/77 checks pass, zero skipped, including existing actual local HTTP bridge, formal delivery, chat/claim uncertain retry, lifecycle and parallel-authority checks. Manifest 8/8. ESLint, secret scan and diff check exit zero. Official manifest regenerated (schema 45, 182 assets). No live listener, credential, ACK, receipt, poll selector, queue admission or auth changes. No deployed/provider latency or newly discovered-message guarantee; an active same-thread turn still blocks its own successors.

Commands (Node v24.22.1):

```sh
node --test tests/room-acp-queue-fairness.test.mjs
node --test tests/room-acp-queue-fairness.test.mjs tests/room-acp-bridge.test.js tests/room-acp-wake-lifecycle.test.js tests/room-acp-chat-retry.test.js tests/room-acp-claim-retry.test.js tests/room-acp-formal-delivery.test.mjs tests/room-acp-authority-view.test.mjs
node --test tests/candidate-manifest.test.js
node node_modules/eslint/bin/eslint.js room-acp/src/queue.mjs tests/room-acp-queue-fairness.test.mjs
node scripts/secret-scan-diff.mjs --files room-acp/src/queue.mjs tests/room-acp-queue-fairness.test.mjs
```

Raw log digests and deterministic compressed logs are saved beside this receipt. No production transcript is included.
