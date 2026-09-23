# Coming from a typed-step-shaped DSL

If there are no feature files and no cucumber glue, the compat door in
`references/cucumber-js.md` is not relevant. Skip straight past it.

What makes that possible is that `pattern` is optional on `defineStep`: a
step can be defined with no pattern at all and still be a complete piece of
CLI-only vocabulary, runnable with `nuka do` and inspectable with
`nuka describe`. That's a different pair of stages from the same rule,
change one thing and then the next so a failure stays traceable to one
change: move each step to a typed `defineStep` first, and bundle it into a
Gherkin `pattern` later, whenever a feature file makes it worth doing.

If the source DSL already carries something like a `description`, `args`,
`returns`, `mutates`, and a `run` function, the translation to `defineStep`
is direct: each has a `defineStep` counterpart to receive it.
