# Act components (isolated stub)

Pure helper. Does not import `server/` or `src/`. Schema stays v26.

Contract: [docs/ACT-COMPONENTS.md](../docs/ACT-COMPONENTS.md).

```sh
npm test
```

`availableComponents({ event, viewer, receipt })` lists Approve / Reject on
proposed-class Events, Open-in-Compute when a Receipt / Compute pointer
exists, and optional Acknowledge. Chat reactions are not Acts.
