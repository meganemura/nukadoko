# The program in Ruby

What the program is, how a world starts it, and every field are in
`../program.md`. This page is how `nukadoko.config.rb` writes it.

## The program

`program:` is a lambda that returns how the program starts. The gem reads
every field `../program.md` names except `lists`, which it refuses by
name, and refuses any key it does not know. A claim on a count of the
`{events}` lines is not in the gem yet. A command never
goes through a shell unless it names one (`["sh", "-c", "..."]`).
`setup`, a `url` that is not a fixed URL, and an environment's `version`
are lambdas; `setup` and a `url` lambda receive the world (`name`,
`root`, `dir`, `tree`, and, for `setup`, `url`, `port`, and `env`).

```ruby
Nukadoko.config(
  program: -> {
    {
      build: [["bin/rails", "assets:precompile"]],
      prepare: [["bin/rails", "db:prepare"]],
      serve: { command: "ruby src/server.rb", ready: "/health" },
      env: { PORT: "{port}", DATABASE_URL: "sqlite3:{dir}/db.sqlite3" },
      setup: ->(world) { Seed.call(world.url) },
    }
  },
)
```

## Environments

An entry of `environments` overrides any field of the program, and
`env` merges by key:

```ruby
env: { CHECKOUT_V2: "{condition.checkout_v2}" },
environments: {
  "checkout-v1": { conditions: { checkout_v2: false } },
  "checkout-v2": { conditions: { checkout_v2: true } },
},
```
