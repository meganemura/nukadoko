# Adding your own evidence

The automatic evidence (screenshot, trace, `http.jsonl`, `page_events`,
and `observed`) never covers something application-specific: a DB row, a
file a child process wrote outside a scratch directory, or the whole of a
response body past the 16 KiB `http.jsonl` keeps. Reach for the `evidence` fixture instead
of `console.log`-ing it away or writing it to disk with no place on the
step record to point back at:

```ts
async run({ evidence, request }, args) {
  const res = await request.get("/orders");
  await evidence.attach("orders.json", await res.body());
}
```

A call through `page.request` or `context.request` is already part of the
automatic evidence above. It lands on `http.jsonl` with `via: "request"`,
the same way the `request` fixture does. In-page `fetch` and navigation
stay `via: "page"`.

A request the step's own code sends through Node's `fetch`, `node:http`,
or `node:https` is a line too, with `via` naming that API. Every line
but a page's keeps the request body and the response body as text, up to
16 KiB each and redacted, and no line keeps headers. A body nukadoko
stopped reading (a `fetch` body past 32 KiB, or one still arriving when
the step ended, marked `incomplete`) has `bytes_read` instead of `bytes`: not the whole size.
A body that failed on its own (the server aborted it, the step destroyed
it) has `bytes_read` and an `error`, and a `node:http` response the step
never read is `{ "unread": "the step did not read the body" }`. A stream or
FormData body the step passes to `fetch` in its `init` is unread too: nukadoko
sends `fetch` exactly what the step passed. A request with no
response when the step ended has `status: 0` and an `error` that says so
and how long it had.
A `fetch` that an interceptor installed after nukadoko (msw, nock)
answers itself never reaches nukadoko, so it has no line; a mocked
`node:http` request still has one.

A step that calls a program's MCP server uses the SDK's own `Client`,
connected in a fixture, with its transport passed through `measureMcp`
(from `nukadoko`); nukadoko adds no client:

```ts
await client.connect(measureMcp(new StreamableHTTPClientTransport(new URL("/mcp", baseURL))));
```

Each request and notification a step sends through it is a line of the
step's `mcp.jsonl` (`evidence.mcp`, counted by `observed.mcp`): the
method, the tool, prompt, or resource, `params` and `result` kept like
a body, `is_error` (the tool reported an error), `error` (a JSON-RPC
error), `duration_ms`, or `unanswered`. The call carries the step's
trace context in `params._meta.traceparent`, and over HTTP to the world
in its header too, so the server's events for it are the step's
(`references/program.md`). An error answer is a result the step reads,
never a failure nukadoko decides. `nuka check` notes
`mcp-transport-unmeasured` for a transport written inside `connect(...)`,
which nothing can wrap: build it first.

A step that talks to the program over a WebSocket uses Node's global
`WebSocket`, usually kept in a scenario fixture; nukadoko adds no
client. Each socket's open and close, and each frame sent or received,
is a line of the step's `websocket.jsonl` (`evidence.websocket`, counted
by `observed.websocket`): `event`, `socket` (a number per socket, so two
people's sockets to one URL stay apart), `url`, `at`, and a text frame's
`data` kept like a body. A frame sent belongs to the step that sent it;
a frame received belongs to the step running when it arrived, so a Then
that waits for a broadcast holds the frames it waited for. When such a
step fails, read this file before putting the last message in the
error text. A socket from the `ws` package goes over `node:http` and is
not seen this way: what it carries is an `unmeasured` socket.

A request, a `runCommand` process, or an MCP call the step's code starts after its
record was written (a timer it left behind) is written beside that
record, marked `after_step_end`, never in the next step's files, and the
run summary names it under the step, with the file that holds the
requests (`http.jsonl`, which the record may not name). A request still
open when the run ends gets its line then. The record does not count it.

What nukadoko saw but cannot measure is in `observed.unmeasured`: a
process started through `node:child_process` instead of `runCommand`
(named by its program and argument count only, never its arguments or a
`NAME=value` word, however it ended), a
`Worker`, a connection the step opened or wrote to that carries no
recorded request (a database client, a pool opened before the step),
what a WebSocket from a library over `node:http` (the `ws` package) or a
CONNECT tunnel carried after its handshake, a UDP
datagram sent through `node:dgram`, a Chromium page's request to the world that went without a `traceparent` because the page's DevTools session failed, or a path the step wrote whose identity nukadoko could not read. Such an
entry says the record holds no evidence of what that action did. Start
the program with `runCommand`, or attach the evidence the action
produced. An empty list means nukadoko saw nothing it could not measure,
not that nothing happened: a Worker's own traffic, a native addon, and a
child process's own traffic are never seen.

`evidence.attach(name, body)` writes and lists the attachment on the step
record's `evidence.attachments` in one call. `evidence.path(name)` only
allocates a path, Playwright's own `outputPath()`, for a step that writes
with its own tool instead of handing `attach` a buffer directly; only a
path a step actually wrote to lands on the step record, so calling `path()`
without following through leaves nothing behind, on purpose. Calling
either twice with the same `name` keeps both files: it never overwrites
the first. A name that differs only by case counts as the same name, so
the second call is suffixed the same way (`Report.txt`, then
`report-2.txt`) and the two do not share one path. A harness file name is
refused with `ReservedEvidenceNameError`: `record.json`, `final.png`,
`trace.zip`, `http.jsonl`, `program-log.txt`, `program-log-late.txt`,
`events.jsonl`, `events-late.jsonl`, `events-read.jsonl`, `mcp.jsonl`, `world` under `nuka do`, and `process-<n>.stdout.txt`,
`process-<n>.stderr.txt`, `process-<n>.stdin.txt`, and
`process-<n>.json` (what a `runCommand` process printed and was given,
and the entry of one that started after the step ended), in any case.
Pick another name.

Compat glue uses `this.attach` instead, in cucumber-js's forms (a
`base64:` media type, `{ mediaType, fileName }`, a stream the step
awaits), and `this.link` takes URLs rather than a display name. Those land
on the step record's `declared` field, not on `evidence.attachments`.

Keep secrets out of whatever you hand `attach`. Record text loses a
loaded secret in the raw form, the percent-encoded form, and the
JSON-escaped form. A JSON number equal to a numeric secret stays a
number. The step record's own `name`/`file` strings are redacted like
every other field, but a file's own contents are not, since redacting
arbitrary bytes would corrupt them about as often as it would protect
them.
