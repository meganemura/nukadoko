# nukadoko for Ruby

The Ruby engine of [nukadoko](../README.md): typed step contracts for Gherkin, written in Ruby, so a scenario can be told wrong before it runs.
It reads the same feature files as the TypeScript engine and must judge them the same way; the cases in [`../conformance/`](../conformance/README.md) hold it to that.

Status: an early core. It checks and runs the todo example. Most of what the TypeScript engine does is not here yet.

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

- Every capture in the pattern is named, and each name is a key of `args`.
- The keyword arguments of `run` (or `observe`, in a Then step) name the fixtures the step needs. `nuka check` reads them with `Method#parameters`, without calling the body.
- A Then step declares `claims` and an `observe` that reads the world. nukadoko judges the claims. `observe` does not receive an args key that a claim compares with.

## Commands

- `nuka check [--json]` reports what is wrong before anything runs.
- `nuka run [--json] [--no-check]` starts the program, runs every scenario, and writes a record per step under `.nukadoko/runs/`.
- Browser launch options go in `nukadoko.config.rb`, as `Nukadoko.config(browser: { executablePath: "..." })`. A step that names `page` gets a browser context of its own for each scenario; each step record holds the requests the page sent and a trace of the step.
- `nuka sig` writes `sig/nukadoko/steps.rbs`. With Steep, a body that reads an undeclared args key or returns the wrong shape is an error.

The program under test is described in `nukadoko.program.rb`:

```ruby
Nukadoko.program serve: { command: "bin/rails server -p {port}", ready: "/up" }
```

## Development

- `bundle install` in this directory.
- `ruby ../conformance/run-rb.rb` runs every conformance case under this engine.

[日本語](README.ja.md)
