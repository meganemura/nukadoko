# Worked example: an HTTP API

A finished project for an API on `node:http`, built with nukadoko 0.16.1
on Node 24.22.0, with its Thens moved to claims and its server moved to
`nukadoko.program.ts` in the release after 0.21.0. Every output block below is copied from a real run of
that project, which is `examples/acceptance/http-api/` in the nukadoko
repository; CI runs it. The rules it follows are in
`../scenario-rules.md`.

## The ticket

An items API. `POST /items` with a name creates the item and answers 201
with its id and name. `GET /items/<id>` answers the item, or 404 with an
error for an unknown id. A body that is not JSON answers 400; a missing
name answers 422. `GET /items` lists every item created so far.

## The feature

`features/items.feature`. One server serves every scenario of the run,
so a scenario claims only on what it created: the name it sent, an id the
API assigned, and the item a Given created, read back or listed (S8).

```gherkin
Feature: items API

  Acceptance criteria (from the request):
  - POST /items with a name creates the item and answers 201 with its id and name
  - GET /items/<id> answers the item, or 404 with an error for an unknown id
  - A body that is not JSON answers 400; a missing name answers 422
  - GET /items lists every item created so far

  Scenario: creating an item
    When I POST this body to /items
      """
      {"name":"lamp"}
      """
    Then the response status is 201
    And the response body has the name "lamp"
    And the response body has an id of at least 1

  Scenario: reading an item back
    Given an item named "lamp" exists
    When I request that item
    Then the response status is 200
    And the response body is the item that was created

  Scenario: an unknown id
    When I request item 0
    Then the response status is 404
    And the response body is
      """
      {"error":"not found"}
      """

  Scenario Outline: a bad request body: <body> answers <status>
    When I POST this body to /items
      """
      <body>
      """
    Then the response status is <status>
    And the response body is
      """
      {"error":"<error>"}
      """

    Examples:
      | body       | status | error              |
      | not json   | 400    | body is not JSON   |
      | {}         | 422    | name is required   |
      | {"name":""}| 422    | name is required   |

  Scenario: the list holds what was created
    Given an item named "desk" exists
    When I request the item list
    Then the response status is 200
    And the list has the item that was created
```

## The steps and the program

- `nukadoko.program.ts`: starts the API once for the run, on a free port,
  waits until `GET /items` answers, and stops it after the scenarios. The
  steps read its URL from `baseURL`. The server starts each log line with
  the request's `traceparent`, so each step record holds the server's
  lines for its own requests in `program-log.txt`.
- `an-item-exists` (Given): POSTs a name and returns the `id` the API
  assigned and the `body` it answered.
- `create-item` (When): `I POST this body to \/items`; sends the docstring
  as it is and returns `status` and `body`.
- `get-item` (When): reads `id` from `an-item-exists` through `from`.
- `get-item-by-id`, `list-items` (When): a literal id, and the list.
- `status-is`, `body-is`, `body-has-name`, `body-has-id` (Then): each
  lists all four request steps in `from`, so exactly one of them runs
  before it in each scenario, and declares one claim. `body-is` reads the
  docstring with `expected_view: "json"`, so the claim compares two JSON
  values, key order does not count, and the record keeps the docstring as
  written.
- `body-is-created-item`, `list-has-created-item` (Then): compare the
  response with the `body` `an-item-exists` returned, by `equal` and by
  `has-item`.

The two steps that POST keep the default `mutates: true`: they change the
API's state. They need no go-ahead before `nuka do`, because the only
server they reach is the one the program file started.

`nukadoko.program.ts`:

```ts
import { defineProgram } from "nukadoko";

// One API server for the whole run, on a port of its own. It keeps its
// items in memory, so a scenario sees the items earlier scenarios created,
// and each one claims only on what it created itself (S8).
export default defineProgram({
  serve: { command: "node src/server.ts", ready: "/items" },
  env: { PORT: "{port}" },
});
```

`features/steps/create-item.ts`:

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "POST /items with this JSON body, verbatim",
  pattern: "I POST this body to \\/items",
  args: z.object({ body: z.string().describe("The request body, sent as-is") }),
  returns: z.object({
    status: z.number().describe("HTTP status"),
    body: z.unknown().describe("The parsed JSON response"),
  }),
  async run({ baseURL }, { body }) {
    const res = await fetch(`${baseURL}/items`, { method: "POST", body });
    return { status: res.status, body: await res.json() };
  },
});
```

`features/steps/list-has-created-item.ts`:

```ts
import { defineStep, z } from "nukadoko";
import anItemExists from "./an-item-exists.ts";
import listItems from "./list-items.ts";

// Other scenarios share the server, so the list holds their items too; the
// claim is that this scenario's item is among them.
export default defineStep({
  description: "The item list holds the item an earlier step created, id and name",
  pattern: "the list has the item that was created",
  args: z.object({
    body: z.unknown().describe("The list the request got"),
    created: anItemExists.returns.shape.body,
  }),
  from: { body: [listItems, "body"], created: [anItemExists, "body"] },
  claims: [{ actual: "body", compare: "has-item", expected: { from: "created" } }],
});
```

`features/steps/status-is.ts`:

```ts
import { defineStep, z } from "nukadoko";
import createItem from "./create-item.ts";
import getItem from "./get-item.ts";
import getItemById from "./get-item-by-id.ts";
import listItems from "./list-items.ts";

export default defineStep({
  description: "The last response's HTTP status is exactly this",
  pattern: "the response status is {expected:int}",
  args: z.object({
    expected: z.number().describe("The expected HTTP status"),
    status: z.number().describe("The status the last request got"),
  }),
  from: { status: [[createItem, "status"], [getItem, "status"], [getItemById, "status"], [listItems, "status"]] },
  claims: [{ actual: "status", compare: "equal", expected: "expected" }],
});
```

## The commands, in order

A `/` in a pattern is Cucumber Expression syntax for alternative text, so
the path in the sentence is refused until it is escaped:

```
$ npx nuka scaffold create-item --pattern 'I POST this body to /items'
refused	invalid-value	-	Refusing to scaffold: This Cucumber Expression has a problem at column 21: I POST this body to /items ^ Alternative may not be empty. If you did not mean to use an alternative you can use '\/' to escape the '/'
  fix: Correct the flag's value as the message says.
  do: nuka scaffold --help
```

`--pattern 'I POST this body to \/items'` wrote the pattern
`"I POST this body to \\/items"`, and the feature line stays `I POST this
body to /items`.

With the Outline named `a bad request body` and no column in the name,
`nuka check` warned (S7):

```
warning	outline-rows-share-name	probe/outline.feature:37	Scenario outline "a bad request body" has 3 Examples rows, and its name uses none of the columns (<body>, <status>, <error>), so every row is reported under the same name.
  fix: Add a column to the name, such as: a bad request body <body>
```

The first version of the feature expected the exact bodies a new, empty
server answers: `{"id":1,"name":"lamp"}` read back, and a list of
exactly lamp and desk. Against the one server of the run, two scenarios
read items an earlier scenario created (S8):

```
  step 4/4  failed  0.0s  the response body is
      claim broken: {"id":2,"name":"lamp"} (from:get-item@22.body) equal {"id":1,"name":"lamp"} (sentence:expected)
...
  step 5/5  failed  0.0s  the response body is
      claim broken: [{"id":1,"name":"lamp"},{"id":2,"name":"lamp"},{"id":3,"name":"lamp"},{"id":4,"name":"desk"}] (from:list-items@57.body) equal [{"id":1,"name":"lamp"},{"id":2,"name":"desk"}] (sentence:expected)
...
7 scenarios: 5 passed, 2 failed  (1s)
```

The claim line names both values and the step each came from (S11): the
body is the one `get-item` on line 22 got, and the id the server assigned
is 2.

The run that passed, with claims on what each scenario created:

```
$ npx nuka check
ok: no issues found
$ npx nuka run
...
scenario 4/7  features/items.feature:45  a bad request body: not json answers 400
...
scenario 5/7  features/items.feature:46  a bad request body: {} answers 422
...
scenario 6/7  features/items.feature:47  a bad request body: {"name":""} answers 422
...
7 scenarios: 7 passed, 0 failed  (1s)
```

The first line, cut above, is `world default: serve 0.3s,
http://localhost:<port>` with the path of the world's `program.log`, which
holds what the server printed. The first version's
`repeated-scenario-prefix` note is gone: the two scenarios that create an
item no longer begin with the same line.

## Decisions

| Date | Decision | Chosen | Why | Became |
| --- | --- | --- | --- | --- |
| 2026-10-16 | Fixture scope for a server that holds state | per scenario | with `scope: "process"`, two scenarios read another scenario's items | S8 |
| 2026-10-16 | One request step per endpoint, or one `I send {method} {path}` | one per sentence the reviewer reads | the sentence names what a user does; the cost is a longer `from` list on each Then | Shapes: an HTTP API |
| 2026-10-16 | A path in a pattern | `\/items` | `/` is alternative text in a Cucumber Expression | Shapes: an HTTP API |
| 2026-10-16 | How the Outline rows are told apart | `<body>` and `<status>` in the name | the summary listed one name three times | S7 |
| 2026-10-16 | The whole body against a docstring, or one claim per field | the whole body | the ticket names the body's fields; a scenario per field would repeat the request | none |
| 2026-10-17 | Acting on `repeated-scenario-prefix` | not acted on | the shared Given writes state the scenario reads | S8 |
| 2026-10-17 | `mutates` on the POST steps | the default `true`, no go-ahead | they change the API's state, but only on the server the fixture started | SKILL.md "Before the first command" |
| 2026-10-24 | Where the API server runs | `nukadoko.program.ts`, one server for the run | the program file is how nukadoko starts a program, and its `program.log` and run.json's `worlds` say which program answered; a fixture that starts one in-process says neither | S8 |
| 2026-10-24 | Expected bodies against a shared server | claims on what the scenario created: the name it sent, an id of at least 1, the body its Given returned | the exact bodies broke as soon as an earlier scenario had created an item (measured above) | S8 |
| 2026-10-24 | The unknown id | `0` | the API numbers items from 1, so no run reaches it; `42` exists once a run, or `--repeat`, has created 42 items | none |
| 2026-10-24 | How the body compares with the docstring | `args` parses the docstring, and one `equal` claim compares the two values | key order and spacing in the docstring do not count; the claim record keeps both values | none |
