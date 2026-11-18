# Claim steps in Ruby

What a claim means, where its values come from, and every compare are in
`../checking-steps.md`. This page is how a Ruby step file writes one.

## A claim step

A Then declares `claims [...]` in place of `def run`, as a list of hashes
with the same keys as in TypeScript (`actual`, `view`, `at`, `count`,
`compare`, `expected`, `expected_view`). A key the line states is a field
of `args` with no `default:`.

```ruby
# conformance/cases/cli/steps-rb/exits_with.rb
class ExitsWith < Nukadoko::Step
  description "The process exit code is exactly this"
  pattern "it exits with {code:int}"
  args do
    number :code, "The expected exit code"
    field :exitCode, RunTally.returns[:exitCode]
  end
  from exitCode: [RunTally, :exitCode]
  claims [{ actual: "exitCode", compare: "equal", expected: "code" }]
end
```

## An expected value an earlier step returned

`from` names the step class and its key as a symbol, and
`field :<key>, <Step>.returns[:<key>]` reuses the producer's field.

```ruby
# conformance/cases/http-api/steps-rb/list_has_created_item.rb
class ListHasCreatedItem < Nukadoko::Step
  description "The item list holds the item an earlier step created, id and name"
  pattern "the list has the item that was created"
  args do
    unknown :body, "The list the request got"
    field :created, AnItemExists.returns[:body]
  end
  from body: [ListItems, :body], created: [AnItemExists, :body]
  claims [{ actual: "body", compare: "has-item", expected: { from: "created" } }]
end
```

## Observe and poll

`def observe(...)` takes the fixtures as keyword arguments, as `run`
does, and reads the args through `args:`. Give every field a description,
so `nuka describe` connects a criterion's wording to the field that
answers it. `poll` takes `timeout_ms:` and `settled:`, or `false`.

```ruby
# conformance/cases/poll/steps-rb/job_ends.rb
class JobEnds < Nukadoko::Step
  pattern "the job ends {wanted:string}"
  description "The job an earlier step started reaches this status in GET /jobs/:id"
  args do
    string :wanted, "The status the job is expected to reach"
    field :id, StartJob.returns[:id]
  end
  from id: [StartJob, :id]
  poll timeout_ms: 3000, settled: [{ actual: "status", compare: "not-equal", expected: { literal: "running" } }]
  claims [{ actual: "status", compare: "equal", expected: "wanted" }]

  def observe(request:, args:)
    { status: request.get("/jobs/#{args.id}").json["status"] }
  end
end
```

## A page by role and name

`observe` returns the page or a locator, and nukadoko takes its ARIA
snapshot. playwright-ruby-client's methods are snake_case
(`page.get_by_role("form", name: "Scores")`).

```ruby
# conformance/engine/projects/claim-aria/steps-rb/scores_form_shows.rb
class ScoresFormShows < Nukadoko::Step
  pattern "the scores form shows"
  description "The scores form's accessibility tree against the tree the docstring states"
  args { string :tree, "Part of the ARIA snapshot the form shows" }
  poll timeout_ms: 2000
  claims [{ actual: "form", compare: "fits-aria-snapshot", expected: "tree" }]

  def observe(page:, args:) = { form: page.get_by_role("form", name: "Scores") }
end
```
