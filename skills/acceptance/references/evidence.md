# Adding your own evidence

The automatic evidence (screenshot, trace, `http.jsonl`, `page_events`)
never covers something application-specific: an API response body, a DB
row, a generated file's contents. Reach for the `evidence` fixture instead
of `console.log`-ing it away or writing it to disk with no place on the
step record to point back at:

```ts
async run({ evidence, request }, args) {
  const res = await request.get("/orders");
  await evidence.attach("orders.json", await res.body());
}
```

A call through `page.request` or `context.request` is already part of the
automatic evidence above. It lands on `observed` and on `http.jsonl` with
`via: "request"`, the same way the `request` fixture does, and a GET or
HEAD stays a read. In-page `fetch` and navigation stay `via: "page"`.

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
`trace.zip`, and `http.jsonl`, in any case. Pick another name.

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
