# Fixtures in Ruby

When to declare a fixture, and how setup and teardown run, are in
`../fixtures.md`. This page is how `nukadoko.config.rb` declares one.

## A project fixture

`Nukadoko.fixture(:name)` in the config declares each one. The block
calls `use` with the value, and what follows is its teardown; a keyword
argument names a fixture it needs. `scope: :process` keeps one value for
the whole run of an environment.

```ruby
# conformance/cases/workflow/config.rb
require_relative "src/signup"

Nukadoko.fixture(:store) { |use| use.(Signup::Store.new) }
```

A step reaches the fixture the same way it reaches `page`, as a keyword
argument: `def run(store:, args:)`.

## Replacing a built-in

A fixture named like a built-in replaces it for every step, and receives
the built-in under the same name.

```ruby
# conformance/cases/page-override/config.rb
Nukadoko.fixture(:page) do |use, page:|
  page.add_init_script(script: "window.wrapped = 'by the project'")
  use.(page)
end
```
