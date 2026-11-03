# The intent file

A change declares what it means to do differently in `INTENT.md` at the
repository's top, before the work it judges.
A reviewer approves the intent as written.
A machine then compares the real behavior change with it.
nukadoko is one such machine: `nuka run --base <ref>` reads the file
against the scenarios' execution events (see "The change's intent" in
[docs/spec.md](spec.md)).
This page is the format alone, so another tool, such as an
application's own comparison of every contract's decision, reads the
same file without nukadoko.

## Where the file is, and which one counts

- The file is `INTENT.md` at the top of the repository.
- It belongs to the change that wrote it.
  A file the base holds with the same text is an earlier change's intent,
  and a reader ignores it.
- Write it in the change's first commit.
  A later commit that changes it is a change of intent, which the
  reviewer reads as such: nukadoko names the commit that declared it,
  whether that was the first, and each later commit that changed it.

## The table

The file is Markdown.
A reader reads one table: the first one whose header row is exactly
this, and its rows up to the first line that is not a table row.
Prose before and after it is for people.

```markdown
| Target | Observation | Before | After |
| --- | --- | --- | --- |
| x_result.reason=plan:team x_result.seats>=10 | x_decision x_result.features | ["projects","sso"] | ["projects","sso","audit_log"] |
```

A cell is the text between two `|`, trimmed.
A `|` inside a cell is written `\|`.
A table with a header and no row declares that nothing changes.

Each row is one claim: for the lines the target names, the observation
goes from before to after.

## Terms

A target and an observation are terms separated by spaces.

- `field<op>value` holds when a line's field has that value.
  `op` is one of `=`, `!=`, `<`, `<=`, `>`, `>=`.
  An order compares two numbers or two strings, and nothing else.
  A line that does not have the field meets no term on it.
- A field is a dotted path into a line: `x_result.seats` is the `seats`
  of the line's `x_result` object.
- A value is JSON when it parses as JSON, and is otherwise the text as
  written: `plan:team` and `"plan:team"` are the same value, `10` is a
  number, and `"10"` is a string.
  A value with a space in it is written as JSON: `"two words"`.
  A term ends at a space that is outside a JSON string and outside
  brackets, so `["a", "b"]` is one value.

## Columns

| Column | Holds |
| --- | --- |
| Target | Which criteria or lines the row is about: `@tag` terms and `field<op>value` terms, all of which must hold. Empty means every one. |
| Observation | A kind of line from [docs/execution-events.md](execution-events.md), then `field<op>value` terms that narrow which lines are observed, then at most one field with no value, the field whose value is observed. |
| Before | What the observation is at the base. |
| After | What it is after the change. |

- A `field<op>value` term of the target is read on the observed line.
  So a condition on a decision's subject is written on the decision's
  own line, such as `x_subject.plan=team` when the line carries its
  subject in `x_subject`.
- A `@tag` term names a scenario tag, and only narrows which scenarios
  the row covers.
  The behavior the row is about is written as `field<op>value` terms
  on the observed line, never as a tag.
  A tool that has no scenarios cannot evaluate a `@tag` term, and
  reports a row that has one as `not_reached`.
- The kind is one of `request`, `db`, `http`, `job`, `flag`, `error`, or
  a writer's own kind that starts with `x_`.
  A field of the format's kind is one a coarse path keeps: `request`
  `method`, `route`, `status`; `db` `table`, `op`; `http` `method`,
  `origin`, `path`, `status`; `job` `name`, `phase`; `flag` `name`,
  `side`; `error` `class`, `handled`.
  A database read is in no path, so `db op=read` matches nothing.
  An `http` line's `origin` on a loopback host (`localhost`,
  `127.0.0.1`, `[::1]`) is compared without its port, since a test run
  picks its ports as it runs, and an `origin` term is read the same
  way: `origin=http://localhost` and `origin=http://localhost:3000`
  both aim at a call to `localhost` on any port.
  An origin on any other host keeps its port.
  A field of a writer's own kind starts with `x_`.
- With no field to observe, before and after are whole numbers: how many
  observed lines one step makes, such as `0` and `1` for a new call.
- With a field to observe, before and after are values of that field.
  The row says that the lines that held before now hold after, as many
  as there were.
  A change of value that also changes how many lines there are is two
  rows: a row with no field to observe for the count, and a row with
  the field for the value.
- When before and after are both empty, the row says that the
  observation does not change, whatever it is.
  A refactor writes `| | x_decision x_result | | |` to say that no
  decision changes.
  Before and after are both filled, or both empty.

## A decision's inputs

A decision event should carry its inputs: the fields a target names,
such as an `x_input` object.
A target is read on the observed line, so a decision that carries its
inputs lets every tool evaluate the same target on the same fields,
whether the tool runs scenarios or compares every contract's decision.

```markdown
| Target | Observation | Before | After |
| --- | --- | --- | --- |
| x_input.plan=team x_input.status=active x_input.seats>=10 | x_decision x_result.features | ["projects","sso"] | ["projects","sso","audit_log"] |
```

## What a row comes to

A tool reports each row as one of these:

| Result | Meaning |
| --- | --- |
| `as_intended` | Each thing the row is about did what it says. |
| `not_happening` | Something the row is about did not do what it says: a count or a value that did not move, or a row of no change that moved. |
| `not_reached` | The comparison found nothing the row is about. Another comparison may reach it. |

And each difference the tool finds is declared by a row, or it is
unintended.
A tool fails on an unintended difference and on a row that is
`not_happening`.
A row that is `not_reached` fails nothing by itself: it says which
comparison has to cover it.

## A reader in a few lines

A reader of another language splits each line of the table at the `|`
that `\` does not escape, trims each cell, and splits a cell into terms
at the spaces outside JSON strings and brackets.
This JavaScript reads the rows:

```js
const lines = text.split(/\r?\n/);
const at = lines.findIndex((line) => /^\|\s*Target\s*\|\s*Observation\s*\|\s*Before\s*\|\s*After\s*\|\s*$/.test(line));
const rows = [];
for (const line of lines.slice(at + 2)) {
  if (!line.trim().startsWith("|")) break;
  const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.replaceAll("\\|", "|").trim());
  rows.push({ target: cells[0], observation: cells[1], before: cells[2], after: cells[3] });
}
```
