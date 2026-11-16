# Writing steps in Ruby

The other references show steps in TypeScript. A Ruby project (the
`nukadoko` gem) reads the same feature files, runs the same loop, and
writes the same records; only the step files and the config differ. This
page says how each TypeScript shape in the other references reads in Ruby.
The full surface is the gem's README
(<https://github.com/meganemura/nukadoko/blob/main/ruby/README.md>), and
`conformance/cases/` in the repository holds the same projects in both
languages (`steps-ts/` beside `steps-rb/`), which both engines must judge
the same way.

Run every command as `bundle exec nuka`.

## A step

```ruby
# features/steps/add_todo.rb is the step add-todo.
class AddTodo < Nukadoko::Step
  pattern "a todo titled {title:string} is added"
  description "Create a todo via POST /todos and return the created record"
  args { string :title, "The title of the todo to create" }
  returns do
    string :id, "The id the server assigned"
    boolean :done, "Whether the todo is done; false for a new one"
  end
  mutates true

  def run(request:, args:)
    request.post("/todos", data: { title: args.title }).json
  end
end
```

| TypeScript | Ruby |
| --- | --- |
| `defineStep({ ... })` in `add-todo.ts` | `class AddTodo < Nukadoko::Step` in `add_todo.rb` |
| `z.object({ title: z.string().describe("...") })` | `args { string :title, "..." }` |
| `.optional()`, `.default(10)`, `.min(1)`, `.positive()` | `optional: true`, `default: 10`, `min: 1`, `positive: true` |
| `z.array(z.object({ ... }))` | `array :todos, "..." do ... end` |
| `async run({ request }, { title })` | `def run(request:, args:)`, reading `args.title` |
| `from: { id: [createTodo, "id"] }` | `from id: [CreateTodo, :id]` |
| `claims: [...]` and `observe` | `claims [...]` and `def observe(...)` |
| `parts: [createTodo]`, `await call(createTodo, args)` | `parts [CreateTodo]`, `call.(CreateTodo, title: "x")` |

The keyword arguments of `run` name the fixtures, as the destructured
first argument does in TypeScript; `nuka check` reads them without
calling the body. `args:` is there only when the body reads it.

## Fixtures

Each fixture has the TypeScript name. Four of them also take a snake_case
name, which passes RuboCop's naming cops and reaches the same fixture:
`base_url`, `require_env`, `page_as`, and `result_of`.

A fixture that TypeScript calls as a function is a lambda in Ruby, called
with `.()`: `section.("checkout")`, `require_env.("API_KEY")`,
`page_as.("aki")`, `result_of.(CreateTodo)`, and
`poll.(description: "the order", interval: 200) { value or nil }`, whose
block stands for the function TypeScript passes. `evidence.attach`,
`evidence.path`, `scratch.dir`, and `scratch.copy` are methods.

A project fixture goes in `nukadoko.config.rb`:
`Nukadoko.fixture(:store) { |use| use.(Store.new) }`, its keyword
arguments naming what it needs.

`Nukadoko.run_command(command, args, cwd:, env:, timeout:)` is the Ruby
form of `runCommand`. `unbundled: true` runs a command in another Ruby
project without nuka's Bundler environment.

## Playwright from Ruby

`page`, `context`, and `page_as` give playwright-ruby-client's objects,
whose method names are snake_case (`page.get_by_role`, `page.goto`). Two
calls do not behave as their TypeScript names suggest:

- `page.wait_for_url` takes a String or a Regexp. A Proc never matches, so
  the wait runs to its timeout.
- `context.expect_page` raises ArgumentError. Wait for a new tab with
  `context.expect_event("page") { page.get_by_text("Open").click }`.
