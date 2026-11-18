# Claim steps in TypeScript

What a claim means, where its values come from, and every compare are in
`../checking-steps.md`. This page is how a TypeScript step file writes one.

## A claim step

A Then declares `claims` in place of `run`. `defineStep` refuses a claim
step that also declares `run`, `returns`, `mutates`, or `parts`. Write
claims as plain data (no getter, Proxy, class instance, hole, or unknown
key) and export what `defineStep` returned: it validates one frozen copy,
and a copy of the step (`{ ...step }`) fails. A key the line states is
required in `args`, with no default, and its schema must not rewrite the
value: `z.coerce`, a transform, a pipe, `trim`, `catch`, a default inside,
or a refine on an object, an array, or the args object is refused.

```ts
// conformance/cases/cli/steps-ts/exits-with.ts
import { defineStep, z } from "nukadoko";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "The process exit code is exactly this",
  pattern: "it exits with {code:int}",
  args: z.object({
    code: z.number().describe("The expected exit code"),
    exitCode: runTally.returns.shape.exitCode,
  }),
  from: {
    exitCode: [runTally, "exitCode"],
  },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
```

## An expected value an earlier step returned

`from` names the step and its key; the step is imported, so a rename is a
type error, and `<step>.returns.shape.<key>` reuses its schema.

```ts
// conformance/cases/http-api/steps-ts/list-has-created-item.ts
import { defineStep, z } from "nukadoko";
import anItemExists from "./an-item-exists.ts";
import listItems from "./list-items.ts";

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

## Observe and poll

`observe(fixtures, args)` takes the same destructured first argument as
`run`. Give every `args` and `returns` field a `.describe()`, so
`nuka describe` connects a criterion's wording to the field that answers
it. `poll` is `{ timeout_ms, settled? }`, or `false`.

```ts
// conformance/cases/poll/steps-ts/job-ends.ts
import { defineStep, z } from "nukadoko";
import startJob from "./start-job.ts";

export default defineStep({
  pattern: "the job ends {wanted:string}",
  description: "The job an earlier step started reaches this status in GET /jobs/:id",
  args: z.object({
    wanted: z.string().describe("The status the job is expected to reach"),
    id: startJob.returns.shape.id,
  }),
  from: { id: [startJob, "id"] },
  async observe({ request }, { id }) {
    const res = await request.get(`/jobs/${id}`);
    const job = (await res.json()) as { status: string };
    return { status: job.status };
  },
  poll: { timeout_ms: 3000, settled: [{ actual: "status", compare: "not-equal", expected: { literal: "running" } }] },
  claims: [{ actual: "status", compare: "equal", expected: "wanted" }],
});
```

## A page by role and name

`observe` returns the page or a locator, and nukadoko takes its ARIA
snapshot. A When may still wait with Playwright's `expect` before it acts;
outside `playwright test`, on Playwright 1.61.1, a failing `expect.soft`
throws at once, and `toMatchAriaSnapshot`, `toHaveScreenshot`, and
`toMatchSnapshot` throw `"<name>() must be called during the test"`.

```ts
// conformance/engine/projects/claim-aria/steps-ts/scores-form-shows.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the scores form shows",
  description: "The scores form's accessibility tree against the tree the docstring states",
  args: z.object({ tree: z.string().describe("Part of the ARIA snapshot the form shows") }),
  observe: ({ page }) => ({ form: page.getByRole("form", { name: "Scores" }) }),
  poll: { timeout_ms: 2000 },
  claims: [{ actual: "form", compare: "fits-aria-snapshot", expected: "tree" }],
});
```
