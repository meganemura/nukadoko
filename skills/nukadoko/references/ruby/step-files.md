# Step files in Ruby

The rules every step follows, whatever its engine, are in `../step-files.md`.
This page is how a Ruby step file writes them. Run every command as
`bundle exec nuka`.

## A step file

One step per file under `featuresDir`, named in snake_case: the file name
with hyphens is the step's name (`add_todo.rb` is `add-todo`). The file
defines a class of the CamelCase name that inherits `Nukadoko::Step`.

```ruby
# conformance/cases/todo/steps-rb/add_todo.rb
class AddTodo < Nukadoko::Step
  pattern "a todo titled {title:string} is added"
  description "Create a todo via POST /todos and return the created record"
  args { string :title, "The title of the todo to create" }
  returns do
    string :id, "The id the server assigned"
    string :title, "The title as the server stored it"
    boolean :done, "Whether the todo is done; false for a new one"
  end
  mutates true

  def run(request:, args:)
    request.post("/todos", data: { title: args.title }).json
  end
end
```

`args` and `returns` take a block of fields: `string`, `number`,
`integer`, `boolean`, `object`, `array`, `unknown`, `table`, and the lists
`strings`, `numbers`, and `integers`, each with an optional description.
A field takes `null: true`, `optional: true`, `default:`, `min:`, `max:`,
`positive: true`, or `negative: true`; `enum :outcome, %w[accepted
refused]` allows only those words. A step that runs code mutates unless
it says `mutates false`. `patterns "another wording"` adds wordings
after `pattern`, each capturing the same keys. `timeout 5000` bounds
`run` or `observe` in milliseconds; without it the config's
`stepTimeout` applies (twenty minutes).

## Loading

Every `*.rb` file under `features/steps/` is loaded, a helper under
`features/steps/lib/` too, so a helper module named after its file can be
used from any step without a `require`. A file that raises while it loads,
or a class whose declaration cannot stand, is reported by `nuka check` as
`step-file-import-failed`.

## The fixtures a step names

The keyword arguments of `run` and `observe` name the fixtures the step
needs; `nuka check` reads them with `Method#parameters` without calling
the body. `args:` is there only when the body reads the args. A keyword
that names no fixture is `fixture-structural-violation`. Each fixture has
the TypeScript name, and four also take a snake_case name that reaches the
same fixture: `base_url`, `require_env`, `page_as`, and `result_of`. A
fixture TypeScript calls as a function is a lambda, called with `.()`:
`section.("checkout")`, `require_env.("API_KEY")`, `page_as.("aki")`,
`result_of.(CreateTodo)`, and `poll.(description: "the order", interval:
200) { value or nil }`. `evidence.attach`, `evidence.path`, `scratch.dir`,
and `scratch.copy` are methods. `request` is the gem's own client
(`get`, `post`, `put`, `patch`, `delete`, with `data:` sent as JSON), and
`Net::HTTP` calls a step makes itself are recorded too.

## The deadline

The gem has no step deadline yet: a step's `run` runs until it returns.
A step that waits on something passes its own timeout to what it calls
(`Nukadoko.run_command(..., timeout:)`, a Playwright wait).

## Parameter types

`parameterTypes:` in `nukadoko.config.rb` takes a
`{ name:, regexp:, transformer: }` hash per type, the transformer a
lambda: `{ name: "priority", regexp: /urgent|later/, transformer: ->(s) {
s == "urgent" ? "high" : "low" } }`. It only coerces the matched text; the `args` schema still
validates the value.

## Several people in one scenario

`page_as.(name)` returns playwright-ruby-client's `Page` in a browser
context of that person's own, so each keeps their own cookies. Take the
name from the feature line, lowercased (`page_as.(args.name.downcase)`).
Its methods are snake_case (`page.get_by_role`). `page.wait_for_url`
takes a String or a Regexp, never a Proc, and `context.expect_page`
raises ArgumentError: wait for a new tab with
`context.expect_event("page") { page.get_by_text("Open").click }`.
