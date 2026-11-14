# nukadoko for Ruby

The Ruby engine of [nukadoko](../README.md): typed step contracts for Gherkin, written in Ruby, so a scenario can be told wrong before it runs.
It reads the same feature files as the TypeScript engine and must judge them the same way; the cases in [`../conformance/`](../conformance/README.md) hold it to that.

Status: an early core. It passes the ten cases in `conformance/`: HTTP steps, browser steps, command-line steps, fixtures a project defines, steps made of parts, polling Then steps, `from`, docstrings, Scenario Outlines, environments with conditions, controls with proof runs, and the verdict table. It runs `--base`, `nuka do`, `nuka scaffold`, and `nuka init`. `nuka check` reports the pattern, position, tag, and outline findings the TypeScript engine reports, and its notes on unbound steps and scaffold descriptions. Much of what the TypeScript engine does is not here yet, such as `--concurrency` and the Allure emitter.

## Install

Add it to the Gemfile of the project under test. It needs Ruby 3.4 or later.

```ruby
gem "nukadoko", group: :test
```

## A step

One step per file under `features/steps/`. The file name is the step name (`add_todo.rb` is `add-todo`).

```ruby
class AddTodo < Nukadoko::Step
  pattern "a todo titled {title:string} is added"
  args { string :title, "The title of the todo to create" }
  returns do
    string :id
    string :title
    boolean :done
  end

  def run(request:, args:)
    request.post("/todos", data: { title: args.title }).json
  end
end
```

- A field takes `null: true` when nil is allowed. `enum :outcome, %w[accepted refused]` allows only those words, and Steep sees them as a union of literals.
- Every capture in the pattern is named, and each name is a key of `args`.
- The keyword arguments of `run` (or `observe`, in a Then step) name the fixtures the step needs. `nuka check` reads them with `Method#parameters`, without calling the body.
- A Then step declares `claims` and an `observe` that reads the world. nukadoko judges the claims. `observe` does not receive an args key that a claim compares with.

## Commands

- `nuka init` writes `nukadoko.config.rb`, the empty `features/steps/`, and the `.gitignore` entries for `.nukadoko/` and `.env` files. It refuses when the config file exists.
- `nuka check [--json]` reports what is wrong before anything runs.
- `nuka run [<feature[:line]|dir>...] [--tag <expression>]... [--env <name>]... [--json] [--no-check]` starts the program in each selected world, runs the selected scenarios, and writes a record per step under `.nukadoko/runs/`. With no target it runs `features/`.
- `nuka verdict [--json]` says whether the newest run judged the working tree as it is now and left nothing red. It never starts a run.
- `nuka report [run] --format markdown [--out <file>] [--json]` renders a run's `summary.md` again from its `run.json` alone, the newest run when none is named.
- `nuka clean [--dry-run] [--json]` removes the run directories under `.nukadoko/`.
- `nuka do <step> [--args <json>] [--use <step-id>]...` runs one step outside any scenario and prints its step record. `--use` fills the step's `from` args from an earlier record, of a `do` or of a run.
- `nuka scaffold <name> [--pattern <p>] [--then] [--description <text>] [--replace]` writes `features/steps/<name>.rb`, a step whose body raises `not implemented` until someone writes it. `nuka scaffold --feature <path>` writes one for each line no step matches, its pattern read from the line. `--command`, `--request`, and `--from` are not here yet.
- Browser launch options go in `nukadoko.config.rb`, as `Nukadoko.config(browser: { executablePath: "..." })`. A step that names `page` gets a browser context of its own for each scenario; each step record holds the requests the page sent and a trace of the step.
- A step that names `scratch` gets `scratch.dir`, a fresh directory that is removed when the scenario ends. `Nukadoko.run_command(command, args, cwd:)` runs a program and returns `{ exitCode:, stdout:, stderr: }`; the step record lists each run.
- A project fixture goes in `nukadoko.config.rb`. The block calls `use` with the value, and what follows is the teardown: `Nukadoko.fixture(:store) { |use| use.(Store.new) }`. `scope: :process` keeps one value for the whole run of an environment.
- `parts [CreateTodo, CompleteById]` declares the steps a step may run, and `call.(CreateTodo, title: args.title)` runs one, with its args and returns checked. A part needs no pattern. Each call is kept under `calls` in the calling step's record. `nuka check` reports a cycle in `parts` and a `mutates false` step whose part declares `mutates true`.
- `poll timeout_ms: 3000` reads `observe` again, 100 ms apart, until every claim holds on two readings in a row or the time runs out. `settled:` names a state that cannot change once reached, so two settled readings in a row stop the wait for a claim that broke. Every reading is kept in the step record.
- `nuka steps [--json]` lists the vocabulary, and `nuka describe <step>` prints one step with the JSON Schema of its args and returns, in the fields the TypeScript engine prints.
- A returned key the contract does not declare is dropped, as a zod object drops it, and the step record names it under `returns_dropped`.
- `nuka sig` writes `sig/nukadoko/steps.rbs`. With Steep, a body that reads an undeclared args key or returns the wrong shape is an error.

The program under test is described in `nukadoko.program.rb`:

```ruby
Nukadoko.program serve: { command: "bin/rails server -p {port}", ready: "/up" }
```

## Development

- `bundle install` in this directory.
- `bundle exec ruby ../conformance/run-rb.rb` runs every conformance case under this engine.
- `bundle exec bin/test` runs the unit tests and the Hegel property tests under `test/hegel/`. The gem needs Ruby 3.4 or later.

[日本語](README.ja.md)
