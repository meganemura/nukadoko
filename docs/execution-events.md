# Execution events, version 1

An execution event is one line that a program writes when one operation
ends: a request it served, a database statement, a transaction, a job,
an outgoing HTTP call, a feature flag it evaluated, an error.
The lines of one request, and of the jobs it enqueued, share one trace
id, so a reader can collect what the program did inside that request, in
the same shape on a laptop, in a test run, in staging, and in
production.

The format assumes no reader.
A test harness, a log pipeline, a database table, and a person with
`grep` and `jq` read the same lines.
Nothing in a line names the tool that reads it.
How nukadoko reads these lines is in [docs/spec.md](spec.md),
"Execution events".

The words "must", "must not", "should", and "may" have their RFC 2119
meanings.

## Where lines go

- A file holds UTF-8 text, one JSON object per line.
  Each line ends with one line feed (0x0A).
  The file has no byte order mark and no blank lines.
- The deployment names the file.
  An environment variable is the usual way; the examples here use
  `EXECUTION_EVENTS`.
  When no path is set, the writer writes nothing and the program runs as
  usual.
- The writer opens the file for appending (`O_APPEND`) and writes each
  line, its line feed included, in one write call.
  Several threads and several processes (a web server and a job worker,
  two server processes) may append to one file this way.
  A writer must not write part of a line, hold lines across operations
  without writing them at each operation's end, or write through a stream
  that splits large writes.
- A line should be at most 4095 bytes before its line feed.
  Appends of one write call up to that size from several processes stay
  whole on the platforms in common use; a longer one can be spliced with
  another process's line.
  A writer leaves out optional fields, `calls` first, rather than write
  a longer line.
  The caps under "Kinds" keep a usual line far below that size.
- A writer should check that the call wrote the whole line.
  A short write leaves a damaged line, which a reader treats as
  unreadable (see "Knowing that a trace is complete"), never as absent.
- Append to a local file.
  A network file system may not keep appends from two hosts whole.
- A writer must not rewrite, truncate, or rotate the file while a reader
  reads it.
  Rotation in production renames the file and starts a new one between
  reads.
  A reader that sees the file get shorter, or a new file at the path,
  knows that what it read may be incomplete.
- A failure to write must not fail the operation.
  The writer should say so once on its standard error.
  The rules under "Knowing that a trace is complete" make a missing line
  visible to a reader.
- Other carriers hold the same record: a row per line in a table, one
  message per line on a stream.
  One JSON object is one event wherever it is kept.

## Inside first

An operation's line is written when the operation ends, after the lines
of every operation inside it.

- A request's line comes after every line that the request's own work
  wrote in that process.
  For a response whose body streams, the line is written when the body
  ends or the client goes away, not when the headers are sent.
- A transaction's line is written when it commits or rolls back.
- A job's `perform` line comes after every line of that run of the job.
- Work that an operation starts and does not wait for (a thread, a
  timer, a deferred callback) is a job: write an `enqueue` line when it
  starts and a `perform` line when it ends.
  Otherwise its lines can come after the request's line, and a reader
  cannot tell that the request's work was still going on.

This rule is what lets a reader treat a request's line and a job's
`perform` line as "everything inside is written".

## Common fields

Every kind may carry these fields.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `trace` | string | yes | The trace the line belongs to (below). |
| `kind` | string | yes | One of the kinds under "Kinds", or a name that starts with `x_`. |
| `id` | string | see below | This operation's id: 1 to 64 characters, unique within its trace. 16 random lowercase hexadecimal characters are recommended. |
| `parent` | string | no | The `id` of the operation this one happened inside, in the same trace. |
| `actor` | string | no | An opaque id of who acted (a user id, a session id, a hash of either). Never a name or an email address. |
| `at` | string | no | `path:line` of the code that performed the operation, with the path relative to the repository root. |
| `dur_ms` | number | no | How long the operation took, in milliseconds, 0 or more. |
| `time` | string | no | When the line was written, RFC 3339 in UTC with `Z`. |
| `v` | integer | no | The format version. Absent means 1. |

### `trace`

`trace` is a W3C Trace Context `traceparent` value
(`00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`), or a bare
trace id of 32 hexadecimal characters.

- A request's line carries the `traceparent` header the request arrived
  with, unchanged.
  The caller put its own span id in that header, so the caller can find
  the line for each call it made.
  A header that is not a valid `traceparent` counts as absent.
- When no valid header arrived, the program makes one with a new random
  trace id and a new random parent id, and uses it as if it had arrived.
- Every line written inside a request carries the same `trace` value as
  the request's line.
- A job carries the `trace` of the operation that enqueued it, in the
  job's own payload.
  Its `enqueue` line, its `perform` line, and every line inside the run
  carry that value.
  A job that no traced operation enqueued (a schedule, a console) makes
  a new trace.
- An outgoing HTTP call should send a `traceparent` with the same trace
  id and the `http` line's `id` as the parent id, so the service it calls
  can write lines in the same trace.
- Writers should write lowercase.
  Readers compare trace ids without regard to case.
  A trace id of all zeros, a parent id of all zeros, and the version
  `ff` are invalid.

### `id` and `parent`

`id` must be present on every line that another line names as `parent`:
a `request`, a `tx`, a job's `perform` line.
It should be present on every line.

`parent` names the nearest enclosing operation.
A statement inside a transaction names the transaction; a savepoint
names the transaction around it; a transaction, a flag, or a job's
`enqueue` line inside a request names the request; a line inside a
job's run names that `perform` line's `id`.
A request's line and a job's `perform` line have no `parent` in the
trace.

## Value rules

- A line is one JSON object (RFC 8259).
  No key appears twice in one object.
- An integer is between -(2^53 - 1) and 2^53 - 1.
  Write a larger integer, such as a 64-bit id, as a string.
- Strings are valid UTF-8, with no unpaired surrogate.
- Write `null` only where "Kinds" allows it.
  Leave an optional field out when there is nothing to say.
- A writer's own fields start with `x_`.
  A reader keeps them and decides nothing on them.
  A field that is neither defined here nor starts with `x_` is a
  mistake; a reader may report it.
- A writer's own kinds start with `x_` too, with the same rule.
  A kind that is neither defined here nor starts with `x_` is a mistake
  or a later version's kind.
  A reader that counts lines must treat such a line as possibly any
  kind.

## Kinds

### `request`: a request the program served

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `method` | string | yes | The HTTP method, uppercase. |
| `route` | string or `null` | yes | The template of the route that matched (`/rooms/:room_id/scores`), never the path with its values. `null` when no route matched. |
| `status` | integer | yes | The status code sent. |
| `calls` | array of strings | no | The application functions the request ran through, as `path:line` of each definition, in the order of first call, each once, at most 200. |

### `db`: one database statement

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `table` | string | yes | The table the statement read or changed. `unknown` when the writer cannot tell. |
| `op` | string | yes | `read`, `insert`, `update`, `delete`, or `other`. `other` is any statement that can change data and is none of the three: an upsert whose branch the writer does not know, a schema change, a procedure call. |
| `rows` | integer or `null` | no | Rows the statement changed or returned. `null` when the driver does not say. |
| `ids` | array of strings or integers | no | The primary keys of the rows the statement changed. Present only when it is complete and has at most 100 entries; leave it out when there are more or the writer cannot tell. |
| `committed` | boolean | no | `true` when the change persisted with no transaction left to decide it (the statement ran outside a transaction). `false` when the writer knows it did not persist. Leave it out inside a transaction, and name the transaction in `parent`. |

### `tx`: a transaction or a savepoint ended

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | The transaction's id, which the statements inside it name as `parent`. |
| `phase` | string | yes | `commit` or `rollback`. |

A savepoint is a `tx` line whose `parent` is the transaction around it.
A transaction that never ends (the process died) has no line, so the
state of its statements stays unknown (see "Whether a statement's change
persisted").

### `job`: a job enqueued, or a run of it ended

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | The job's type or class name. |
| `queue` | string | no | The queue it went to. |
| `phase` | string | yes | `enqueue` or `perform`. |
| `job_id` | string | yes | The job system's id of the job: the same value on its `enqueue` line and on its `perform` line. |
| `calls` | array of strings | no | As on `request`, for the run. |

- The `perform` line is written when the job system is done with that
  enqueue: the job ran to the end, raised, or was dropped without
  running.
  A dropped job's `perform` line has no lines inside it.
- A run that will be tried again writes the retry's `enqueue` line
  before its own `perform` line, since the retry was decided inside the
  run.
  A reader then never sees the job as done between a failed run and its
  retry.
- A job that is enqueued with a delay writes its `enqueue` line when it
  is enqueued, and its `perform` line when it runs.

### `http`: an outgoing HTTP call

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `method` | string | yes | The HTTP method, uppercase. |
| `origin` | string | yes | `scheme://host` with the port when it is not the default. Never user information. |
| `path` | string | yes | The path, with no query and no fragment. A template when the client knows one. |
| `status` | integer or `null` | yes | The status code received. `null` when no response came. |

### `flag`: a feature flag evaluated

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | The flag's name. |
| `side` | string | yes | What the program got: `on`, `off`, or a variant's name. |
| `gate` | string | no | What decided it: `boolean`, `actor`, or `percentage`. |

Write one line for each evaluation, the `off` side too.
A difference between two sides' paths needs both.

### `error`: an error raised

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `class` | string | yes | The error's class or code. |
| `handled` | boolean | yes | `true` when the program caught it and went on, `false` when it ended the operation. |

There is no message field: messages carry values.
`at` should name where the error was raised.

## Whether a statement's change persisted

A reader decides the commit state of a `db` line from the lines of its
trace only:

1. When the line has `committed`, that is its state, unless a `tx` on
   its parent chain rolled back, which makes the state unknown.
2. Otherwise, follow `parent` while it names a `tx` line of the trace.
   The change persisted when every `tx` on that chain committed.
   It did not persist when any of them rolled back.
   The state is unknown when the chain names an id that no line of the
   trace has (yet), or when an id appears on two lines.
3. A line with neither `committed` nor a `tx` parent has an unknown
   state.

A reader must never read an unknown state as either answer.
A writer that cannot name the transaction a statement ran in leaves both
out, and the statement's state is honestly unknown.

Two cases a writer gets wrong easily:

- Rails 8.1, when it rolls back to a savepoint, sends
  `ROLLBACK TO SAVEPOINT x` and then, at once, `RELEASE SAVEPOINT x`.
  A writer that reads `RELEASE` as a commit reports a write that was
  rolled back as persisted.
  Pair the two statements by the savepoint's name, and write a `tx` line
  for the first outcome only.
- A write inside a transaction that began before the request has no
  transaction line in the trace: the test's own transaction around each
  test, which a test framework opens so that the test leaves no rows
  behind, is the usual case.
  `committed: true` is false there, since the test's transaction rolls
  back when the test ends.
  Give such a statement a `parent` that no line of the trace carries, so
  that a reader resolves its state as unknown.
  In Rails, `connection.transaction_open?` tells the two cases apart for
  a statement outside every transaction the request began: it is true
  inside the test's transaction, and false when the statement commits on
  its own.

## Knowing that a trace is complete

A count of lines ("no row was written", "one score was inserted") means
something only when the reader knows that every line it counts has been
written.
The format gives the reader these facts:

1. **Every request it sent has its line.**
   The caller knows the parent id it put in each `traceparent` it sent,
   and each request's line carries that header back.
   When the line for each of those ids is in the file, the inside-first
   rule says the requests' own work is written.
   A line whose `trace` is a bare trace id stands for one request, which
   one unknown.
2. **Every job is done.**
   For each `job_id` in the trace, the file holds at least as many
   `perform` lines as `enqueue` lines.
   The order does not matter: a fast job can write its `perform` line
   before the request writes its own.
3. **Nothing was lost on the way.**
   The file was not replaced, truncated, or made shorter while the
   reader read it.

Until all three hold, a count is a lower bound only.
And:

- No line at all for a trace is never evidence that nothing happened: a
  program without a writer, or with the wrong path, writes nothing too.
  Fact 1 needs at least one request line.
- A line the reader cannot parse, of a kind or a version it does not
  know, or whose field a count reads is missing or invalid, may be any
  line.
  It raises the upper bound of a count by one; it never disappears.
- A line of the trace that arrives after the reader decided means the
  decision was made on less than the whole trace.
  The reader should keep that line apart, as late, and say that the
  decision was not final.
- Lines from several processes are in write order, not in time order.
  A reader must not assume that one process's line came before another's
  because it is earlier in the file.

## What a line must not hold

- No values from rows, no statement text with values, no request or
  response bodies, no headers, no cookies, no tokens, no error messages.
- Primary keys only, at most 100 of them on one line.
- Route templates, not paths with ids.
  Outgoing paths without the query.
- `actor` is opaque.

Trace ids and span ids are not secrets.
A pipeline that redacts lines should keep 32-character and 16-character
hexadecimal ids whole, because they are what ties the lines of a trace
together.

## Versions

This is version 1.
A writer of version 1 leaves `v` out or writes `1`.
Any change to the kinds, the fields, or the rules above is a new
version, and its lines carry `v`.
A reader that does not know a line's version treats the line as
unreadable: it may be any line.

## Example

A request places a score.
It reads the room, evaluates a flag, inserts the score inside a
transaction, enqueues a job that recalculates the ranking, and commits.
A separate worker process runs the job, which updates the ranking
outside a transaction.
Both processes append to one file.
The caller sent
`traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.

```jsonl
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"db","id":"9c1e0b7a4d2f8e63","parent":"5a0f3c9e1b7d2486","table":"rooms","op":"read","rows":1,"dur_ms":0.3}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"flag","id":"e47b2d90c3a15f68","parent":"5a0f3c9e1b7d2486","name":"score_input_slider","side":"off","gate":"boolean"}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"db","id":"2b8d6f0e9a3c1745","parent":"c7e2a1f04b9d3866","table":"scores","op":"insert","rows":1,"ids":[42],"at":"app/models/room.rb:88","dur_ms":0.6}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"job","id":"0d5c8a2e7f1b3946","parent":"5a0f3c9e1b7d2486","name":"ScoreRecalcJob","queue":"default","phase":"enqueue","job_id":"3f2a9c41"}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"tx","id":"c7e2a1f04b9d3866","parent":"5a0f3c9e1b7d2486","phase":"commit","dur_ms":1.4}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"request","id":"5a0f3c9e1b7d2486","method":"POST","route":"/rooms/:room_id/scores","status":303,"dur_ms":12.5}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"db","id":"8f3a0c6d2e9b1574","parent":"b1d94e7a0c3f5862","table":"rankings","op":"update","rows":3,"committed":true,"dur_ms":0.9}
{"trace":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01","kind":"job","id":"b1d94e7a0c3f5862","name":"ScoreRecalcJob","queue":"default","phase":"perform","job_id":"3f2a9c41","dur_ms":4.1}
```

What a reader can say, line by line:

- After line 6, the caller's request (parent id `00f067aa0ba902b7`) has
  its line, so the request's own work is written.
  Job `3f2a9c41` has one `enqueue` and no `perform`, so the trace is not
  complete yet: "the ranking was not changed" cannot be known.
- After line 8, the job has one `perform` for its one `enqueue`, and the
  trace is complete.
- The insert on line 3 names transaction `c7e2a1f04b9d3866`, which line
  5 says committed, so the score persisted.
  Line 7 states `committed: true` itself.
- Inserts into `scores` that persisted: exactly 1.
  Writes that persisted: exactly 2 (lines 3 and 7).
  Flags evaluated: `score_input_slider`, side `off`.

The same request, refused because the score is out of range, writes one
line, and a reader that sent it can say "nothing was written" once that
line is there and no job is open:

```jsonl
{"trace":"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01","kind":"request","id":"71e0c4a9d3b28f56","method":"POST","route":"/rooms/:room_id/scores","status":422,"dur_ms":3.2}
```
