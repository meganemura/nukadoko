# Worked example: an HTTP API

A finished project for an API on `node:http`, built with nukadoko 0.16.1
on Node 24.22.0. Every output block below is copied from a real run of
that project, which is `examples/acceptance/http-api/` in the nukadoko
repository; CI runs it. The rules it follows are in
`../scenario-rules.md`.

## The ticket

An items API. `POST /items` with a name creates the item and answers 201
with its id and name. `GET /items/<id>` answers the item, or 404 with an
error for an unknown id. A body that is not JSON answers 400; a missing
name answers 422. `GET /items` lists every item created so far.

## The feature

`features/items.feature`. The ids in the expected bodies come from the
ticket's "id and name" and from each scenario starting with an empty
server (S8).

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
    And the response body is
      """
      {"id":1,"name":"lamp"}
      """

  Scenario: reading an item back
    Given an item named "lamp" exists
    When I request that item
    Then the response status is 200
    And the response body is
      """
      {"id":1,"name":"lamp"}
      """

  Scenario: an unknown id
    When I request item 42
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
    Given an item named "lamp" exists
    And an item named "desk" exists
    When I request the item list
    Then the response status is 200
    And the response body is
      """
      [{"id":1,"name":"lamp"},{"id":2,"name":"desk"}]
      """
```

## The steps and the fixture

- `server` (a config fixture, scoped per scenario): starts the API on a
  free port and closes it after the scenario. The API holds its items in
  memory, so each scenario gets a new, empty one.
- `an-item-exists` (Given): POSTs a name and returns the `id` the API
  assigned.
- `create-item` (When): `I POST this body to \/items`; sends the docstring
  as it is and returns `status` and `body`.
- `get-item` (When): reads `id` from `an-item-exists` through `from`.
- `get-item-by-id`, `list-items` (When): a literal id, and the list.
- `status-is`, `body-is` (Then): each lists all four request steps in
  `from`, so exactly one of them runs before it in each scenario.

The two steps that POST keep the default `mutates: true`: they change the
API's state. They need no go-ahead before `nuka do`, because the only
server they reach is the one the fixture started.

`nukadoko.config.ts`:

```ts
import { defineConfig, defineFixtures } from "nukadoko";
import { startServer } from "./src/server.ts";

export default defineConfig({
  fixtures: defineFixtures({
    // One server per scenario: the API keeps its items in memory, so a shared
    // server would let one scenario's items show up in another's list.
    server: async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.close();
    },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    server: Awaited<ReturnType<typeof startServer>>;
  }
}
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
  async run({ server }, { body }) {
    const res = await fetch(`${server.url}/items`, { method: "POST", body });
    return { status: res.status, body: await res.json() };
  },
});
```

`features/steps/status-is.ts`:

```ts
import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
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
  mutates: false,
  run({}, { expected, status }) {
    assert.equal(status, expected, `status: expected ${expected}, got ${status}`);
  },
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

With the `server` fixture changed to `{ scope: "process" }`, two
scenarios read items an earlier scenario created (S8):

```
  step 4/4  failed  0.0s  the response body is
      body: got {"id":2,"name":"lamp"}
...
  step 5/5  failed  0.0s  the response body is
      body: got [{"id":1,"name":"lamp"},{"id":2,"name":"lamp"},{"id":3,"name":"lamp"},{"id":4,"name":"desk"}]
...
7 scenarios: 5 passed, 2 failed  (1s)
```

That message also names only the actual value, so `body-is` now names
both (S11).

The run that passed, scoped per scenario:

```
$ npx nuka check
ok: no issues found
$ npx nuka run
...
scenario 4/7  features/items.feature:50  a bad request body: not json answers 400
...
scenario 5/7  features/items.feature:51  a bad request body: {} answers 422
...
scenario 6/7  features/items.feature:52  a bad request body: {"name":""} answers 422
...
7 scenarios: 7 passed, 0 failed  (1s)
```

`nuka tend` reported one note, and it was not acted on:

```
$ npx nuka tend
scanned: features
bed: typed 7, compat 0, read-only 5
declared: describe 18/18
note	repeated-scenario-prefix	features/items.feature	2 scenarios begin with the same 1 step, which took 0 seconds across them, 6.5% of this run's summed scenario time. The shared steps: "an item named "lamp" exists". "an item named "lamp" exists" does not declare mutates: false, so a later scenario may read what this opening writes: a "process"-scope fixture would share that state between scenarios. A Background keeps the shared steps in one place and still runs them for each scenario.
  fix: No change is necessary. A Background can hold the shared steps. A process-scope fixture fits only an opening whose steps all declare mutates: false.
```

The shared step writes the item that each scenario then reads by id, so a
process-scope fixture would bring back the failure above. The note says
so, because the step keeps the default `mutates: true`.

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
