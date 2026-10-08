# Semantic gates — contract

Post-test static checks. Each gate is an **executable file** in this
directory (any language: shell, node, python). Non-executable files
(`_template.sh`, this README) are ignored.

## Invocation

```
<gate-name> <repoDir> <baseSha> <headSha>
```

- `repoDir` — absolute path of the candidate's scratch worktree (the
  **head** tree; read-only use).
- `baseSha` / `headSha` — full commit SHAs; use
  `git -C "$repoDir" diff "$baseSha" "$headSha" --name-only` to scope the check
  to the candidate's diff.

## Output contract

Print **exactly one JSON object** to stdout, exit 0:

```json
{
  "name": "<gate-name>",
  "pass": true,
  "violations": [
    {"file": "client/config.json", "key": "room.name",
     "occurrences": 2, "introducedByMerge": true}
  ],
  "detail": "no duplicate JSON keys in changed files"
}
```

- `pass: false` with a non-empty `violations` array flips a green test
  verdict to **red** (`fail`, `fail_reason` names the gate).
- Keep `violations` to the schema above so B1's verdict renderer can display
  them uniformly; extra fields are allowed but not required.
- `detail` is a one-line human summary (shown in logs and the verdict).

## Failure semantics

| gate outcome | pipeline verdict |
|---|---|
| exit 0, `pass: true` | unchanged |
| exit 0, `pass: false` | `fail` (green → red flip) |
| non-zero exit / invalid JSON / timeout (`T_GATE`, default 300 s) | `gate-error` — pipeline infra, exit 2, retry the pipeline; never blamed on the candidate |

Gates run **only** when the test verdict is green-ish
(`pass`, `pass-with-flakes`, `pass-with-baseline-failures`); otherwise the
verdict's `gates` section records `"verdict": "skipped"`.

## Selection

- Default: every executable in this dir, sorted by filename.
- `VERIFY_GATES="name1:name2"` — explicit ordered list.
- `VERIFY_GATES_DIR` — use a different gates directory.
- `VERIFY_SKIP_GATES=1` — disable the stage.

## Reserved names

- `duplicate-json-keys` — sibling B3's gate
  (`checkDuplicateJsonKeys({repoDir, baseSha, headSha}) →
  {pass, violations: [{file, key, occurrences, introducedByMerge}]}`).
  Drop the executable in as `gates/duplicate-json-keys`; no pipeline changes
  needed.
