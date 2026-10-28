# GitHub-native merge queue, not a lane-run bot

**Date:** 2026-09-26
**Decider:** jill lane (per deep-dive recommendation, S3)

GitHub's merge queue (one checkbox in repo settings) does batch-then-bisect:
PRs queue instead of merging; GitHub rebases onto latest main, runs the
required checks on the exact merged result, merges or ejects the culprit.

**Why not a lane-run bot:** a `scripts/room merge-queue` verb + cron would
reimplement GitHub's feature without atomic batching and race with manual
merges. The room's existing discipline (full-green hosted CI on the exact
head before merge) maps 1:1 onto merge-queue required checks.

**Status:** needs one owner tap (John) to enable the setting.
Fallback documented in the deep-dive if refused.

**Source:** `~/workspace/software-factory-research-2026-09-26/DEEP-DIVE-2.md` §5
