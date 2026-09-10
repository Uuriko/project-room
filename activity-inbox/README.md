# Activity inbox (isolated stub)

Pure read-model. Does not import `server/` or `src/`. Schema stays v26.

Contract: [docs/ACTIVITY-INBOX.md](../docs/ACTIVITY-INBOX.md).

```sh
npm test
```

`projectActivity({ viewer, events, receipts })` lists ack-needed, failed
Receipt, mention, and exception rows. Default notify tier is Mentions +
exceptions. Plain message volume is ignored.
