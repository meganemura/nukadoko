# The program under test

## The program file

The config holds the criteria. `nukadoko.program.ts`, beside it, holds
how a run gets the program the scenarios talk to: how to build it,
prepare its state, start it, and the env its processes get. `nuka init`
does not write it; write it from what the project's README or CI script
already runs.

```ts
import { defineProgram } from "nukadoko";

export default defineProgram({
  build: ["npm run build"],              // once per run, in the tree's root
  prepare: ["node dist/migrate.js"],     // once per world, with env below
  serve: { command: "node dist/server.js", ready: "/health" },
  env: { PORT: "{port}", DATABASE_PATH: "{dir}/app.sqlite3" },
});
```

`nuka run` starts one world per environment: it runs `build` and
`prepare`, starts `serve` on a free port, waits until `ready` answers
2xx, runs the scenarios against that URL (the base URL of `page`,
`request`, and the `baseURL` fixture), and stops the program after the
AfterAll hooks. `nuka do` does the same for its one execution. No
terminal has to keep a server running, and no fixture starts one.

A command is an argv array, or a string split on whitespace. Neither goes
through a shell; write `["sh", "-c", "a && b"]` when one is needed. The
program learns its port only from `{port}`, in the command or in `env`.

| Placeholder | Its value |
| --- | --- |
| `{port}`, `{url}` | the port `serve` got, and the world's URL |
| `{dir}` | the world's own directory under the run: its database, its pid file |
| `{root}` | the tree's root, the one placeholder `build` may name |
| `{world}` | the environment's name |
| `{token}` | random per world, redacted as `{{secret.WORLD_TOKEN}}` in every record |

One world serves every scenario of an environment, so what one scenario
writes is there for the next: a scenario creates what it reads and claims
only on that (`scenario-rules.md`, S8, and `examples/http-api.md`).

A step reads the same `env`: in `process.env` during the run and in the
`env` fixture, after the config's env files. `setup(world)` runs once per
world before the first scenario, to seed data.

## When it does not start

A world that does not start fails the run with `program-start-failed`,
which names the command, how it ended, and the end of the world's
`program.log`: read that file first, at
`.nukadoko/runs/<run_id>/worlds/<environment>/program.log`. No scenario
runs in that environment. A fixed `port` something else already answers
on is refused the same way, since every request would reach a server
nukadoko did not start. `program-exited` (a warning) says the program
died during the run, which the failed steps alone would not.

`run.json`'s `worlds` names what each world ran, its URL, its timings,
and its log; each step record names its world in `world_name`.

## Environments and programs nukadoko does not start

An entry of `environments` overrides any field above (`env` merges by
key), so a feature flag is `{ env: { CHECKOUT_V2: "1" } }` and `nuka run
--env new-checkout` runs it. `url` in place of `serve` names a program
that runs elsewhere, such as a staging server, and starts nothing: give it
`build: []` and `prepare: []` when the top level has them, and
`policy: "read-only"` when the data there belongs to someone else.

A tree with no program file starts no world, which suits a command-line
tool whose steps run commands with `runCommand`. "Program" in
docs/spec.md has every field.
