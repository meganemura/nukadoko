# nukadoko for Ruby

The Ruby engine of [nukadoko](../README.md): typed step contracts for Gherkin, written in Ruby, so a scenario can be told wrong before it runs.
It reads the same feature files as the TypeScript engine and must judge them the same way; the cases in [`../conformance/`](../conformance/README.md) hold it to that.

Status: it passes every scenario under `conformance/engine/`, which runs each `nuka` command against both engines, and the ten cases in `conformance/`: HTTP steps, browser steps, command-line steps, fixtures a project defines, steps made of parts, polling Then steps, `from`, docstrings, Scenario Outlines, environments with conditions, controls with proof runs, and the verdict table. It runs `--base`, `--step`, `nuka do`, `nuka scaffold`, and `nuka init`. `nuka check` reports the pattern, position, tag, outline, `from` order, fixture, and parse findings the TypeScript engine reports, and its notes on unbound steps, unused fixtures, unused `from` keys, and scaffold descriptions. Some of what the TypeScript engine does is not here yet, such as `nuka init --allure`.

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
- `optional: true` lets the key be absent, and the body reads nil, as zod's `.optional()`: a key that `from` fills in some scenarios only. `default: 10` reads an absent key as that value, as `.default(10)`. `min:`, `max:`, `positive: true`, and `negative: true` bound a number's value, a string's length, and an array's item count, with zod's messages.
- `array :todos do string :id end` is a list of objects. `strings`, `numbers`, and `integers` are lists of one scalar type, and `array :ids, of: :string` names any item type. `each: { positive: true }` bounds every item.
- Every `*.rb` file under `features/steps/` is loaded, a helper under `features/steps/lib/` too. A step class is looked up by the CamelCase form of its file name (`add_todo.rb` defines `AddTodo`), so a helper module named the same way (`lib/todo_api.rb` defines `TodoApi`) can be used from any step without a `require`.
- Every capture in the pattern is named, and each name is a key of `args`.
- The keyword arguments of `run` (or `observe`, in a Then step) name the fixtures the step needs. `nuka check` reads them with `Method#parameters`, without calling the body.
- The `request` fixture sends `get`, `post`, `put`, `patch`, and `delete` and records each in the step's `http.jsonl`. A path joins the program's URL; an absolute `http` or `https` URL goes where it names, so a step can call a third-party API, in a project with no program too.
- `context` is the browser context `page` belongs to. `page_as.("aki", { javaScriptEnabled: false })` gives the page of a browser context of its own for the name, so a second person in the scenario keeps cookies of their own. A later call for the name gets the same page. Each step that calls it keeps `trace.aki.zip`, and the scenario ends with `final.aki.png`.
- `section.("label")` marks a stage the body reached, in the record's `sections`. `poll.(description: "the order", timeout: 30_000, interval: 500) { value or nil }` calls the block until it gives a value, raises `Nukadoko::PollTimeoutError` when the time runs out, and keeps each call in `polls`. `evidence.attach(name, body)` writes a file into the step's own directory, and `evidence.path(name)` gives a path there to write to; the record lists both in `evidence.attachments`. `result_of.(MakeTotal)` reads what an earlier step of the scenario last returned, or nil.
- `base_url:`, `require_env:`, `page_as:`, and `result_of:` are the snake_case names of `baseURL`, `requireEnv`, `pageAs`, and `resultOf`, so a body passes RuboCop's naming cops. Either name reaches the same fixture. `require_env.("KEY")` raises when the key is missing or empty, and the record lists each key asked for in `required_env`.
- A Then step declares `claims` and an `observe` that reads the world. nukadoko judges the claims. `observe` does not receive an args key that a claim compares with.

## Commands

- `nuka init` writes `nukadoko.config.rb`, the empty `features/steps/`, and the `.gitignore` entries for `.nukadoko/` and `.env` files. A Rakefile with no `scenarios` task gets one that runs `bundle exec nuka run`, so people and CI run `rake scenarios`. It refuses when the config file exists.
- `nuka check [--json]` reports what is wrong before anything runs.
- `nuka run [<feature[:line]|dir>...] [--tag <expression>]... [--env <name>]... [--order file|shuffled[:<seed>]] [--repeat <n>] [--concurrency <n>] [--proof-runs <n>] [--step] [--records] [--json] [--no-check]` starts the program in each selected world, runs the selected scenarios, and writes a record per step under `.nukadoko/runs/`. With no target it runs `features/`. `--order shuffled` plays the files, then each file's scenarios, in an order a seed names, the same order the TypeScript engine plays for that seed. `--repeat` plays the selection that many times, `--concurrency` spreads whole feature files over that many worker processes (a file tagged `@nukadoko:serial` on its Feature line runs alone, after them), `--proof-runs` sets how many times each control runs, and `--records` writes each scenario record to stdout as it ends.
- `nuka verdict [--json]` says whether the newest run judged the working tree as it is now and left nothing red. It never starts a run.
- `nuka judge <feature>:<line> [--run <id>] [--json]` shows the values a run read for a criterion whose Then asks for a judgment (a `judged-as` claim). With `--meets` or `--misses`, `--by <who>`, and `--because <one sentence>` it records a judgment of them in `judgments/<feature>.json`, which the next run reads the criterion against.
- `nuka report [run] --format markdown|messages|allure [--out <path>] [--json]` renders a run again from its run directory alone, the newest run when none is named. `markdown` is its `summary.md`. `messages` is a cucumber-messages stream, one envelope per line, so a formatter or a JUnit step that reads cucumber's protocol keeps working: a claim step's claims and each criterion's verdict ride as attachments. `allure` is a directory of Allure results, `.nukadoko/export/allure-results` unless `--out` names another: one result per execution, each claim a child step of its Then, with the history id the TypeScript engine's results of the same scenario carry.
- `nuka run <feature>:<line> --step` walks one scenario a step at a time: after each step it waits until `nuka step` answers. `nuka step wait [--walk <n>] [--timeout <s>] [--json]` prints where the walk stands: the step it paused after, its record, and a screenshot and an ARIA snapshot of the page it left open. `nuka step next <pause> --walk <n>` runs the next step, and `nuka step stop <pause> --walk <n>` skips the rest, which leaves the scenario stopped and its row red. Either engine's `nuka step` answers either engine's walk.
- `nuka clean [--dry-run] [--json]` removes the run directories under `.nukadoko/`.
- `nuka skill path` prints the directory that holds the agent skills the gem ships (`nukadoko` and `nukadoko-verification`), the same skills the npm package ships.
- `nuka do <step> [--args <json>] [--use <step-id>]...` runs one step outside any scenario and prints its step record. `--use` fills the step's `from` args from an earlier record, of a `do` or of a run.
- `nuka scaffold <name> [--pattern <p>] [--then] [--description <text>] [--replace]` writes `features/steps/<name>.rb`, a step whose body raises `not implemented` until someone writes it. `nuka scaffold --feature <path>` writes one for each line no step matches, its pattern read from the line. `--command <entry point>` writes a step that runs the program under Ruby in a scratch directory and returns `exitCode`, `stdout`, and `stderr` (`--cwd <key>` runs it in the directory an args key holds, and `--argv <key>` splits one capture into its arguments). For an executable a gem installs, `bundle binstubs <gem>` writes `bin/<name>`, an entry point `--command` can run. `--request "<METHOD> <path>"` writes a step that sends one request and returns `status` and `body` (`--body <key>` sends that args key). `--from <step>.<key>` fills an args key from an earlier step's returns; with `--then` and one capture, the claim compares the two, so the step needs no edit.
- Browser launch options go in `nukadoko.config.rb`, as `Nukadoko.config(browser: { executablePath: "..." })`. A step that names `page` gets a browser context of its own for each scenario; each step record holds the requests the page sent and a trace of the step.
- A step that names `scratch` gets `scratch.dir`, a fresh directory that is removed when the scenario ends, and `scratch.copy(source)`, one that holds a copy of a file or directory of the project. A body that names no `args:` keyword is called without them. `Nukadoko.run_command(command, args, cwd:, env:, input:, timeout:, redact:)` runs a program and returns `{ exitCode:, signal:, stdout:, stderr: }`; the step record lists each run, with each `redact:` value the step holds written as `{{secret.NAME}}`. The program inherits nuka's environment, which under `bundle exec` names nuka's Gemfile; `unbundled: true` runs it with the environment from before Bundler, for a command in another Ruby project such as `bin/rails runner`.
- `Nukadoko.config(envFiles: [".env"])` loads env files into the `env` fixture, and an environment of the config's `program:` adds its own `envFiles:` after them. A file git does not track, or one that differs from HEAD, is a secret source: each of its values four characters or longer is written as `{{secret.NAME}}` in every step record, `http.jsonl`, and what `nuka do` prints, and what a step prints reaches stderr with them redacted. `secrets: { public: [...], redact: [...] }` keeps one such key plain, or redacts one key of a tracked file. `nuka check` warns about a missing file, a line it skipped, and a `secrets` key no file defines, and never prints a value.
- `Nukadoko.config(parameterTypes: [{ name: "priority", regexp: /高|低/, transformer: ->(s) { s == "高" ? "high" : "low" } }])` registers a parameter type, as `parameterTypes` does in the TypeScript config, so `{p:priority}` reads a value inside a sentence with no spaces around it. The regexp is a Ruby Regexp or a string, and the transformer, which may be left out, is given the groups the regexp captured. `nuka check` reports a type that takes a built-in name, one no pattern names, and a claim that compares with a capture a transformer rewrote.
- A project fixture goes in `nukadoko.config.rb`. The block calls `use` with the value, and what follows is the teardown: `Nukadoko.fixture(:store) { |use| use.(Store.new) }`. `scope: :process` keeps one value for the whole run of an environment. A keyword argument names what the fixture needs: another project fixture, or a builtin (such as `page`, `request`, `env`, `requireEnv`, `baseURL`, `scratch`). A fixture with a builtin's name replaces it for every step, and its own `page:` is the builtin, so it can wrap it: `Nukadoko.fixture(:page) { |use, page:| page.set_default_navigation_timeout(10_000); use.(page) }`. `nuka check` refuses a `page` override that names none of `page`, `context`, and `pageAs` (`page-override-unowned`).
- `parts [CreateTodo, CompleteById]` declares the steps a step may run, and `call.(CreateTodo, title: args.title)` runs one, with its args and returns checked. A part needs no pattern. Each call is kept under `calls` in the calling step's record. `nuka check` reports a cycle in `parts` and a `mutates false` step whose part declares `mutates true`.
- `poll timeout_ms: 3000` reads `observe` again, 100 ms apart, until every claim holds on two readings in a row or the time runs out. `settled:` names a state that cannot change once reached, so two settled readings in a row stop the wait for a claim that broke. Every reading is kept in the step record.
- `nuka steps [--json]` lists the vocabulary, and `nuka describe <step>` prints one step with the JSON Schema of its args and returns, in the fields the TypeScript engine prints.
- A step with no `returns` keeps nothing `run` gives back, so its body can end on any call; a Hash with keys fails, naming the keys it would lose.
- A returned key the contract does not declare is dropped, as a zod object drops it, and the step record names it under `returns_dropped`.
- `nuka sig` writes `sig/nukadoko/steps.rbs`. With Steep, a body that reads an undeclared args key or returns the wrong shape is an error.

The program under test is described by `program:` in `nukadoko.config.rb`, a lambda that returns how the program starts:

```ruby
Nukadoko.config(
  program: -> { { serve: { command: "bin/rails server -p {port}", ready: "/up" } } },
)
```

## Development

- `bundle install` in this directory.
- `bundle exec ruby ../conformance/run-rb.rb` runs every conformance case under this engine.
- `bundle exec bin/test` runs the unit tests and the Hegel property tests under `test/hegel/`. The gem needs Ruby 3.4 or later.
- `bundle exec rbs-inline --output=sig/generated lib` writes the signatures from the `#:` and `# @rbs` comments in `lib/`, and `bundle exec steep check` checks `lib/` against them. Commit what rbs-inline writes. `sig/nukadoko.rbs` holds what rbs-inline cannot write, and `sig-deps/` the parts of other gems that ship no signature.

[日本語](README.ja.md)
