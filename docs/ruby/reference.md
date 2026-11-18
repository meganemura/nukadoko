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

A step that uses `page` needs a browser that `playwright-ruby-client`
can launch.

## Configuration

`nuka init` writes `nukadoko.config.rb`, which calls
`Nukadoko.config(...)` with the options as keywords, under the same names
as the TypeScript config: `program` and project fixtures below,
`envFiles:` and `secrets:` for the `env` fixture, `browser:` for the
browser's launch options, and `parameterTypes:` for a parameter type
read inside a sentence:

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

`mutates false` declares a step that changes nothing. Every `*.rb` file
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
whole run of an environment:

```ruby
Nukadoko.fixture(:page) do |use, page:|
  page.add_init_script(script: "window.wrapped = 'by the project'")
  use.(page)
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

## Types and tooling

`nuka sig` writes `sig/nukadoko/steps.rbs`, the RBS of each step's args
and returns. With Steep, a body that reads an undeclared args key or
returns the wrong shape is an error.

## Not in this engine

`nuka check --codes` and `nuka check --fail-on` are in the TypeScript
engine only. The two doors that bring an existing suite in, from
cucumber-js and from Playwright Test, are JavaScript suites, so they are
the TypeScript engine's.
