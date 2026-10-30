# The program under test

## The program file

The config holds the criteria. `nukadoko.program.ts`, beside it, holds how a run
gets the program the scenarios talk to: how to build it, prepare its state,
start it, and the env its processes get. `nuka init` does not write it; write it
from what the project's README or CI script already runs.

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
through a shell; write `["sh", "-c", "a && b"]` when one is needed. The program
learns its port only from `{port}`, in the command or in `env`. `ready` is a
path on the program's own server, and only a 2xx answer counts: a redirect is
not followed, so name a path that answers 200 with no login (`/up`, `/health`).
`url` is an `http:` or `https:` URL with no user or password in it.

| Placeholder | Its value |
| --- | --- |
| `{port}`, `{url}` | the world's port (the one `serve` got, or the `url`'s, 443 or 80 when it names none) and URL |
| `{dir}` | the world's own directory under the run: its database, its pid file |
| `{root}` | the tree's root, the one placeholder `build` may name |
| `{world}` | the environment's name |
| `{token}` | random per world, redacted as `{{secret.WORLD_TOKEN}}` in every record |
| `{events}` | a private empty file a world nukadoko serves gets for its program's execution events |
| `{condition.<name>}` | the value the environment declares for that condition: `true`, `false`, or the string |
A placeholder a world has no value for (`{port}` or `{url}` with neither `serve`
nor `url`, `{events}` without `serve`, `{condition.<name>}` where the
environment does not declare it, anything but `{root}` in `build`) is
`program-placeholder-unfilled`: `nuka check` reports it for the worlds a `nuka
run` with the same `--env` flags would start, and `nuka run` and `nuka do`
refuse it before any command runs.

One world serves every scenario of an environment, so what one scenario
writes is there for the next: a scenario creates what it reads and claims
only on that (`scenario-rules.md`, S8, and `examples/http-api.md`).

A step reads the same `env`: in `process.env` during the run and in the
`env` fixture, after the config's env files. `setup(world)` runs once per
world before the first scenario, to seed data; what it prints reaches
stderr and `program.log` redacted. A `setup` or `url` function past its
limit is abandoned and its `signal` aborted: it stops only if it honours it.

Every phase has a limit: 600 s for each `build` or `prepare` command, 60 s for
`serve` to answer `ready`, `setup`, and a `url` function. Write `{ command,
timeout_ms }` for a command, `serve.timeout_ms`, `setup: { run, timeout_ms }`,
or `url: { resolve, timeout_ms }` for another, in whole milliseconds up to
2147483647, the longest delay a Node.js timer keeps. Each phase prints `world
<name>: <phase> started` on stderr, so a long wait names what it waits on. A
`build` or `prepare` command's process group is killed when the command exits:
a service that has to outlive `prepare`, such as a database, starts with
`setsid`, as a daemon does. `serve.command` stays in the foreground: one that
daemonizes, as `rails server -d` does, exits before `ready` answers and fails
the world, and the daemon keeps running, out of nukadoko's reach.

## When it does not start

A world that does not start fails the run with `program-start-failed`,
which names the command, how it ended (a phase past its limit included),
and the end of the world's `program.log`: read that file first, at
`.nukadoko/runs/<run_id>/worlds/<environment>/program.log`. No scenario
runs in that environment. A fixed `port` something else already answers
on is refused the same way, since every request would reach a server
nukadoko did not start. `program-exited` (a warning) says the program
died during the run, which the failed steps alone would not.

`run.json`'s `worlds` names what each world ran, its URL, its timings,
and its log; each step record names its world in `world_name`.

## Each step's lines of the program's log

Every request a step sends to the world's origin (through `fetch`, `node:http`,
`request`, and a Chromium page) carries a W3C `traceparent` with the step's own
trace id. A request that sets its own keeps it. When the program writes the
trace id into its log lines, each step record gets the lines that carry its
trace id in `program-log.txt` beside it, counted in `observed.program_log`
(`{ trace_id, lines, file, stamped }`). Read that file first when a step against
the program fails: it holds what the server did for that step. A line that
arrived after the step ended is still that step's, in `program-log-late.txt`
beside the record; the run summary names it on the step's line.

`lines: 0` with `stamped` above 0 says only that no line carried the
step's trace id by the time its record was written. Read the run
summary's line for the world, decided from the whole log once the world
stopped: "carries no trace ids" means the program does not tag its
lines; "arrived after that step ended" counts the lines that came late.
When it adds that none came in time, output buffered on a pipe is a
possible cause: `STDOUT.sync = true` fixes it in Ruby and
`PYTHONUNBUFFERED=1` in Python. For Rails, send the test log to stdout
and tag it, in `config/environments/test.rb`:

```ruby
config.logger = ActiveSupport::TaggedLogging.logger($stdout) if ENV["RAILS_LOG_TO_STDOUT"].present?
config.log_tags = [ ->(request) { request.headers["traceparent"] } ]
```

with `RAILS_LOG_TO_STDOUT: "1"` in the program file's `env`. A Node
server prints `req.headers.traceparent` at the start of each line it
writes for a request. A world at a `url` has no log nukadoko reads:
`observed.program_log` is `null`, and the server's own log finds a
step's requests by the `traceparent` on its `http.jsonl` lines, each
with `traceparent_sent_to`, the origins that received it.

## Each step's execution events

A program can also write one JSON line per operation it ends (a request, a
statement, a transaction, a job, an outgoing call, a flag, an error) to the file
`{events}` names, in the format of docs/execution-events.md:
`env: { EXECUTION_EVENTS: "{events}" }`. Each line carries the request's
`traceparent`, a job's the one that enqueued it, so the lines of every process
the program runs reach the step that caused them. Each step record gets its
lines, redacted, in `events.jsonl` beside it, counted in `observed.events`
(`{ trace_id, lines, file, kinds, stamped, stamped_spans, unreadable, unowned,
process_spans, process_requests, whole, open }`, and `mcp_spans` after an MCP
call). A `runCommand` process gets the step's trace context as `TRACEPARENT`,
an MCP call through `measureMcp` in `params._meta.traceparent`
(`references/evidence.md`); a tool or a stdio server that copies it into its
requests' `traceparent` header makes their lines the step's (`process_requests`
counts a tool's). Only the program gets the variable that names `{events}`,
never a step or a process it starts, so no line a step writes reads as the
program's. Read it to see what the program did inside a step: which tables it
read and wrote, which jobs it enqueued and ran.

`whole: true` says every request the step stamped has its `request` line, every
job it enqueued performed, each `runCommand` process it ran ended with its
process group, and each MCP call went to the world over HTTP. `whole: false`
never says nothing more happened: `open` names why, one word each: `no-requests`
(no stamped request, `runCommand` process, or MCP call, such as a Then that only
reads the page), `processes-unbounded` (a process it ran still runs, left its
group running, or ran on Windows), `mcp-unbounded` (an MCP call went over stdio
or to another origin), `no-lines` (no writer, or a wrong variable),
`request-unreported`, `jobs-pending` (with `job_ids`), `unreadable` (a line
spliced or cut), `truncated`, `file-replaced`. A line that arrived later is in
`events-late.jsonl`, and the run summary names it. The whole file, redacted, is
in `worlds/<environment>/events.jsonl`; a world at a `url` has none, and
`observed.events` is `null` there. run.json's step gets `path`, what its trace
did, late lines included (writes, jobs, requests, flags; no reads); its flags
and requests make run.json's `flags` and `routes`, and `lists` (docs/spec.md
"Lists") names those no step reached (`references/verdicts.md`).

## Claiming what the program did

A Then counts an earlier step's events: `events: { writes: { of: placeScore,
count: { kind: "db", op: ["insert", "update", "delete", "other"], committed:
true } } }` beside a claim on `actual: "writes"` and a number. It waits while
they may still be `whole` (the step's `timeout`, else 10 s), and is `unjudged`,
naming the gap, while the count is a range: an absence holds on a whole reading
only. Its line and `events_read` name what it `counted`, and what a `db` count
with no `table` left out on tables `lists.tables` marks (`left_out`,
`references/diagnosing.md`); a line after the claim makes the cell `broke`.
`events-inlet-missing` and `events-unread` name a world that reads none (a
`--base` ref without `{events}` still runs).

## Environments and programs nukadoko does not start

An entry of `environments` overrides any field above (`env` merges by
key). A feature behind a switch gets one environment per side, each
naming its side in `conditions`:

```ts
env: { CHECKOUT_V2: "{condition.checkout_v2}" },
environments: {
  "checkout-v1": { conditions: { checkout_v2: false } },
  "checkout-v2": { conditions: { checkout_v2: true } },
},
```

`conditions` sets nothing, and nukadoko does not check it against the program;
`{condition.checkout_v2}` hands the program the declared side, so the two
cannot disagree. It says which side the environment is on for a scenario's
`@with:checkout_v2` or `@without:checkout_v2` tag (`references/verdicts.md`).
`nuka run` without `--env` runs every environment that declares `conditions`,
or the ones a top-level `defaultEnvironments` names, so a deployment target can
declare its switches and stay out. `url` in place of `serve` names a program
that runs elsewhere, such as a staging server, and starts nothing: give it
`build: []` and `prepare: []` when the top level has them, and
`policy: "read-only"` when the data there belongs to someone else. Under
`nuka run --base`, a `url` function receives `tree` and branches on it: one
that answers the base world with head's URL leaves that world not run.

A tree with no program file starts no world, which suits a command-line
tool whose steps run commands with `runCommand`. "Program" in
docs/spec.md has every field.
