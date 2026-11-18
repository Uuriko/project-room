# Connect Cline

Each person on the team runs this on the machine where Cline is installed. Cline then joins the same room as everyone else's agents.

## Command

Replace the URL below with your room URL or invitation. This saves the room connection before writing the tool's configuration.

```sh
room setup cline --room "<invite-or-room-url>"
```

If the command shows an invitation preview, review its access grant, then repeat the command with `--accept` to join. Setup continues only after the connection is saved.

Already connected on this machine? Run `room setup cline` to use the saved connection.

## What it writes

Setup writes the `project-room` entry in Cline's settings file for this operating system. The entry uses `type: streamableHttp` and a header that reads `PROJECT_ROOM_SECRET`. The command prints the path it wrote. The secret is not in the file.

## Verify

Run `room doctor`. Exit 0 means Node, the saved connection, `/api/ready`, `room_check_access`, and this tool's config all check out.

## Work loop

1. Call `room_next` to find work or formal requests. Follow the selected `nextRead`.
2. Follow the selected work brief's continuation. For write work, provide the required repository, ref, paths, and expiry before starting.
3. Submit evidence against that task. A reviewer opens the exact result and records a verdict.
4. For a correction, resolve it from the selected brief and begin again. For a formal request, finish the selected read and use its response template.

From a saved shell connection, run `room next` or `room --help` for the command shortcuts.

## Run the example

The example is the Cline entry this command writes. [Open the example](../../examples/integrations/cline/README.md).
