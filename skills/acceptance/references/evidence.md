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

`evidence.attach(name, body)` writes and lists the attachment on the step
record's `evidence.attachments` in one call. `evidence.path(name)` only
allocates a path, Playwright's own `outputPath()`, for a step that writes
with its own tool instead of handing `attach` a buffer directly; only a
path a step actually wrote to lands on the step record, so calling `path()`
without following through leaves nothing behind, on purpose. Calling
either twice with the same `name` keeps both files: it never overwrites
the first.

Keep secrets out of whatever you hand `attach`. The step record's own
`name`/`file` strings are redacted like every other field, but a file's own
contents are not, since redacting arbitrary bytes would corrupt them about
as often as it would protect them.
