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

## Each step's lines of the program's log

Every request a step sends to the world's origin (through `fetch`,
`node:http`, `request`, and a Chromium page) carries a W3C `traceparent`:
one trace id per scenario, one span id per step. A request that sets its
own keeps it. When the program writes that value into its log lines,
each step record gets the lines its own requests caused in
`program-log.txt` beside it, counted in `observed.program_log`
(`{ lines, file, stamped }`). Read that file first when a step against
the program fails: it holds what the server did for that step.

`lines: 0` with `stamped` above 0 means the program does not tag its
lines, and the run summary says so once per world. For Rails, send the
test log to stdout and tag it, in `config/environments/test.rb`:

```ruby
config.logger = ActiveSupport::TaggedLogging.logger($stdout) if ENV["RAILS_LOG_TO_STDOUT"].present?
config.log_tags = [ ->(request) { request.headers["traceparent"] } ]
```

with `RAILS_LOG_TO_STDOUT: "1"` in the program file's `env`. A Node
server prints `req.headers.traceparent` at the start of each line it
writes for a request. A world at a `url` has no log nukadoko reads:
`observed.program_log` is `null`, and the server's own log finds a
step's requests by the `traceparent` on its `http.jsonl` lines.

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
