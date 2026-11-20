# The Ruby engine

How a step, a fixture, and a config are written for the `nukadoko` gem.
What a feature file, a claim, a run, and a record mean is the same in both
engines, and [the spec](../spec.md) says it once. The
[TypeScript engine's page](../typescript/reference.md) has the same
headings in the same order, so the two can be read side by side.

## Install and command

Ruby 3.4 or later. Add the gem to the Gemfile of the project under test,
and run it with `bundle exec nuka`:

```ruby
gem "nukadoko", group: :test
```

```sh
bundle install
bundle exec nuka init
```

When the project has a `Rakefile`, `init` adds a `scenarios` task to it
that runs `bundle exec nuka run`, the one command a person or CI runs.

A step that uses `page` needs a browser that `playwright-ruby-client`
can launch.

## Configuration

`nuka init` writes `nukadoko.config.rb`, which calls
`Nukadoko.config(...)` with the options as keywords, under the same names
as the TypeScript config: `program` and project fixtures below,
`envFiles:` and `secrets:` for the `env` fixture, `browser:` for the
browser's launch options, `stepTimeout:` for how long a step may run
(in milliseconds, twenty minutes by default), and `parameterTypes:` for a
parameter type read inside a sentence:

```ruby
Nukadoko.config(parameterTypes: [{ name: "priority", regexp: /高|低/, transformer: ->(s) { s == "高" ? "high" : "low" } }])
```

## Defining a step

One step per file under `features/steps/`, named in snake_case; the file
name is the step name with hyphens (`an_item_exists.rb` is
`an-item-exists`). The file defines a class of the CamelCase name that
inherits `Nukadoko::Step`:

```ruby
class AnItemExists < Nukadoko::Step
  description "Create an item through the API so a later step can read it"
  pattern "an item named {name:string} exists"
  args { string :name, "The item's name" }
  returns do
    number :id, "The id the API assigned"
    object :body, "The item as the API answered it" do
      number :id
      string :name
    end
  end

  def run(baseURL:, args:)
    res = Net::HTTP.post(URI("#{baseURL}/items"), JSON.generate(name: args.name))
    raise %(creating "#{args.name}": status #{res.code.to_i}, not 201) unless res.code.to_i == 201

    item = JSON.parse(res.body)
    { id: item["id"], body: item }
  end
end
```

`mutates false` declares a step that changes nothing. `patterns` adds
more wordings of the same step after `pattern`, and every wording must
capture the same keys (`alias-key-mismatch` otherwise). `timeout 5000`
bounds the step's own `run` or `observe` in milliseconds; past it the
step fails with `error.kind` `timeout`, and without it the config's
`stepTimeout` applies.

```ruby
class ItemCount < Nukadoko::Step
  description "Count the items the API lists"
  pattern "I count the items"
  patterns "the items are counted"
  timeout 5000
  # ...
end
```

`requires`, `gives`, and `ends` name the states a line needs held, leaves
held, and leaves not held: a name, or a name and the args key whose value
tells one holder from another (`requires ["signed-in", :person]`). `nuka
check` walks each scenario through them and reports `state-missing` at a
line that can only run without its state, and `nuka run` refuses that
scenario before any step runs. The spec's "States" says what to declare.

Every `*.rb` file
under `features/steps/` is loaded, a helper under `features/steps/lib/`
too, so a helper module named after its file can be used from any step
without a `require`.

## Fields and schemas

`args` and `returns` take a block of fields: `string`, `number`,
`integer`, `boolean`, `object`, `array`, `unknown`, and the lists
`strings`, `numbers`, and `integers`. A field takes `null: true` when nil
is allowed, `optional: true` when the key may be absent, and `default:`
for the value an absent key reads as. `enum :outcome, %w[accepted refused]`
allows only those words. `min:`, `max:`, `positive: true`, and
`negative: true` bound a number's value, a string's length, and an
array's item count, with zod's messages. `nuka describe` prints each
schema as the same JSON Schema the TypeScript engine prints.

## Captures, tables, and doc strings

Each `{key:type}` in the pattern fills the args key `key`. A data table
reaches its key through `table`, and a doc string as a `string`:

```ruby
args { table :todos, "The data table's rows, one todo per row, the title in the first cell" }
```

## Claims

A Then step declares `claims` and an `observe` that reads the world, in
place of `run`. nukadoko judges each claim ("Claims" in
[the spec](../spec.md#claims)). `observe` does not receive an args key
that a claim compares with.

`files written: { of: RunBuild, change: "added", under: "src" }` names
the paths the commands of an earlier step added, changed, or removed,
and a claim reads the key as its actual ("Files an earlier step
changed" in [the spec](../spec.md#files-an-earlier-step-changed)). The
list comes from that step's record, from each `Nukadoko.run_command` it
ran, never from what its `run` returned.

`events writes: { of: PlaceScore, count: { kind: "db", op: %w[insert
update delete other], committed: true } }` counts the execution events of
an earlier step, and a claim reads the key as its actual ("A claim on a
count of events" in [the spec](../spec.md#a-claim-on-a-count-of-events)).
A value of the count can come from the sentence, `table: { sentence:
"table" }`. The step reads the lines of that step's trace before it
judges its claims, and keeps each reading in its record's `events_read`.

## Chaining (`from`)

`from id: [StartJob, :id]` fills `id` with what the step `StartJob`
returned earlier in the scenario. `field :id, StartJob.returns[:id]`
reuses the producer's field for the key.

## Parts

`parts [CreateTodo, CompleteById]` lists the steps `run` may call, and
`call.(CreateTodo, title: args.title)` runs one with its args and returns
checked ("Parts" in [the spec](../spec.md#parts)):

```ruby
parts [CreateTodo, CompleteById]

def run(call:, args:)
  created = call.(CreateTodo, title: args.title)
  completed = call.(CompleteById, id: created.id)
  { id: completed.id, done: completed.done }
end
```

## Fixtures

`Nukadoko.fixture` in the config adds a project fixture. The block calls
`use` with the value, and what follows is its teardown. A keyword
argument names a fixture it needs, and a fixture named like a builtin
replaces it for every step. `scope: :process` keeps one value for the
whole run of an environment. `use` returns how the scope ended,
`"passed"` or `"failed"`, so a teardown can keep what a failure left. A
teardown that raises is a `fixture-teardown-failed` warning, and the
scenario keeps its status; the scenario record keeps the error in
`teardown_errors`:

```ruby
Nukadoko.fixture(:page) do |use, page:|
  page.add_init_script(script: "window.wrapped = 'by the project'")
  use.(page)
end
```

A fixture that makes an MCP client passes its transport through
`Nukadoko.measure_mcp`, so each call a step sends is a line of the step's
`mcp.jsonl` and carries the step's trace context (docs/spec.md "MCP
calls"):

```ruby
Nukadoko.fixture(:notes) do |use, base_url:|
  transport = Nukadoko.measure_mcp(MCP::Client::HTTP.new(url: "#{base_url}/mcp"))
  client = MCP::Client.new(transport: transport)
  client.connect
  use.(client)
  transport.close
end
```

## Context

The keyword arguments of `run` and `observe` are the fixtures the step
needs: `page`, `context`, `page_as`, `request`, `env`, `require_env`,
`base_url`, `scratch`, `section`, `poll`, `evidence`, `result_of`, and
`call`. `baseURL`, `requireEnv`, `pageAs`, and `resultOf` reach the same
fixtures under the TypeScript names. `nuka check` reads them with
`Method#parameters`, without calling the body ("Context API" in
[the spec](../spec.md#context-api)). `scratch.dir` is a fresh directory,
removed when the scenario ends. `Nukadoko.run_command` runs a program and
records it in the step record.

## Polling and waiting

`poll timeout_ms: 3000, settled: [...]` on a Then step reads `observe`
again until every claim holds on two readings in a row, or the time runs
out.

## Program

The program under test is `program:` in the config, a lambda that
returns how the program starts:

```ruby
Nukadoko.config(
  program: -> { { serve: { command: "bin/rails server -p {port}", ready: "/up" } } },
)
```

Its fields are under "Program" in [the spec](../spec.md#program).
`serve` takes `command`, `port` (`"auto"`, the default, or a number
nothing answers on yet), `ready` (default `/`), and `timeout_ms`
(default 60000): the world is ready once `ready` answers 2xx within
`timeout_ms`. A command is an Array of words, or a String split on
whitespace; neither goes through a shell, so a program that needs one
writes `["sh", "-c", "..."]`. A key the program does not know is
refused, and so is a key the TypeScript engine reads and this one does
not yet (below). A world whose program does not start runs none of its
scenarios, and the run fails with `program-start-failed` and the end
of the world's `program.log`.

A world goes through the phases in the TypeScript engine's order:
`build` (commands run once per tree per run, before any world), `prepare`
(commands run once per world, with its env and placeholders), then
`serve` or `url` (a URL, or a lambda that returns one, for a program
nukadoko does not start), then `setup` (a lambda that receives the world:
`name`, `root`, `dir`, `tree`, `url`, `port`, and `env`). A command may
be `{ command:, timeout_ms: }`, and `setup` and a `url` lambda may be
`{ run: }` or `{ resolve: }` with a `timeout_ms`. A phase that fails, or
runs past its limit, stops the world and names itself. An environment
takes `policy: "read-only"`, which fails every step that declares it
mutates, and `version:`, a lambda whose String goes into run.json and
every record as `target_version`. A placeholder a world has no value for
(`{port}` in a world with neither `serve` nor `url`, anything but
`{root}` in `build`) is `program-placeholder-unfilled` in `nuka check`.

A served world whose program names `{events}` gets an empty file outside
the run directory, which the program appends its execution events to.
Each step's lines are kept beside its record and summed up in its
`observed.events`, and the world's redacted copy goes beside
`program.log` once the world stops ([spec](../spec.md), "Execution
events").

## Compat steps (the migration door)

A cucumber-ruby suite comes in with its step definitions and support files
as they are. Every `.rb` file under `features/` loads in cucumber-ruby's
order: `features/support/env.rb`, the rest of `features/support/`, then the
other files. `Given`, `When`, `Then`, `And`, `But`, `Before`, `After`,
`AfterStep`, `BeforeAll`, `AfterAll`, `World`, and `ParameterType` are at
the top level, as cucumber-ruby defines them. Typed step files load beside
them, so one scenario can bind both kinds.

```ruby
World(BasketHelpers)

Before("@tagged") do
  @tagged = true
end

When("I add {int} apples") do |count|
  count.times { @basket << "apple" }
end

When("I add these fruits:") do |table|
  table.hashes.each { |row| row["count"].to_i.times { @basket << row["name"] } }
end
```

- A compat step is named by its pattern, `compat: <pattern>`, and a Regexp
  pattern is written `/.../`. A string is a cucumber expression and reads
  the same parameter types as typed steps. A step takes no options, and an
  options hash is refused when the file loads. `nuka steps` lists the step
  as `compat`, `nuka describe` says it has no contract, and `nuka do`
  refuses it (`compat-step-not-runnable`): promote it to a `Nukadoko::Step`
  to run it alone.
- The block gets the matched values in order, then the line's table or doc
  string. A block whose parameters the match does not fill fails the step,
  as cucumber-ruby fails it. A table is a `DataTable` with `raw`, `rows`,
  `hashes`, `symbolic_hashes`, `rows_hash`, `transpose`, and `cells_rows`.
  `diff!`, `map_headers!`, and `map_column!` are refused, never half done.
  The step record keeps the table as its raw rows.
- Each scenario gets one World, which its hooks and compat steps share.
  `World(Module)` mixes a module in, and `World { MyWorld.new }` builds the
  object. A namespaced `World` is refused. The engine does not measure the
  World's reads and writes: an instance variable has no accessor to wrap,
  so a compat step record has no `world`.
- `step "text"` runs another compat step on the same World, inside the
  record of the step that called it. `steps` with Gherkin text and
  `skip_this_scenario` are refused. `pending` fails the step with the
  error kind `unsupported`, since nukadoko has no pending outcome. `log`
  and `attach` go into the step record's `attachments`.
- `open_page` and `open_request` return the page and the request nukadoko
  measures, so their trace, screenshots, and requests are the step's. They
  work inside a step only. A Capybara `page` the glue starts itself runs,
  with no trace.
- `Before` and `After` get the scenario (`name`, `source_tag_names`,
  `location`, `status`, `failed?`, `passed?`), and `AfterStep` gets the
  step's result and its line. A hook's tags are `@tag` or `not @tag`, and
  all the tags one hook names must hold; anything wider is the error
  `unsupported-hook-tag-expression`. A `Before` that fails stops the
  `Before` hooks after it and skips every step. `After` runs in reverse
  order, after a failure too. `AfterStep` runs after each step that began,
  and its failure stops the scenario as the step's own would. Each run of
  a hook is an entry in the scenario record's `hooks`, and a hook opens no
  page.
- `BeforeAll` and `AfterAll` run once for each environment's pass, with no
  World, in the process the workers of `--concurrency` fork from. A failure
  is the finding `hook-failed`, and a `BeforeAll` that failed plays no
  scenario.
- `Around`, `InstallPlugin`, and `AfterConfiguration` are refused when the
  file loads. A file that raises is `step-file-import-failed`, and the other
  files still load.
- A compat step judges by raising or not, so one in Then position is the
  warning `then-compat-step`, and run.json gives the scenario
  `judged_by: "compat"`.

## Types and tooling

`nuka sig` writes `sig/nukadoko/steps.rbs`, the RBS of each step's args
and returns. With Steep, a body that reads an undeclared args key or
returns the wrong shape is an error.

## Not in this engine

What the TypeScript engine has and this one does not yet. The spec marks
each of its examples with `<!-- engine: typescript -->`.

- The door from Playwright Test. It brings a JavaScript suite in, so it is
  the TypeScript engine's ([doors.md](../typescript/doors.md)). The compat
  door above is this engine's form of the TypeScript engine's door from
  cucumber-js.
