---
worker: {{WORKER_ID}}
contextRef: swarm-wave@v1:ef16b4ee3b7e
slots:
  BRIEF_BODY: "<describe this worker's value>"
  DELIVERABLES: "<describe this worker's value>"
  DONE_CONDITION: "<describe this worker's value>"
  TASK_TITLE: "<describe this worker's value>"
  WORKER_ID: "<describe this worker's value>"
---

WAVE-500 coord-cost worker {{WORKER_ID}}/17 ({{TASK_TITLE}}).

Context: one-shot worker under the WAVE-500 coordination-overhead coordinator.
Every worker brief repeats the same standing context. At 500 agents that's the
same kilobytes x 500.

YOUR BRIEF (bounded):
1. Read the live work-claims board before starting. Don't duplicate siblings
   or other lanes. First-claim-wins.
2. Work in ~/workspace/pr-wave500-coord-cost (branch wave500/coord-cost —
   verify before committing). TMPDIR=~/workspace/pr-wave500-coord-cost/.tmp.
   scripts/ + docs/ only.
3. {{BRIEF_BODY}}

Done: {{DELIVERABLES}}, committed + pushed to origin wave500/coord-cost.
Report back: {{DONE_CONDITION}}.
