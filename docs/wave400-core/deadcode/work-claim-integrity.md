# Dead code — server/work-claim-integrity.mjs

**None found.** All exports are imported by `server/work-claim-routes.mjs`
(the only importer, verified by grep). Internal helpers (`invalid`,
`pullUrlOf`) are both used. All six exported constants are referenced either
in-module or by the importer. `statusFlights` WeakMap is read and written by
`readBoardDeployStatus`.
