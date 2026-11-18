# The program in Ruby

What the program is, how a world starts it, and every field are in
`../program.md`. This page is how `nukadoko.config.rb` writes it.

## The program

`program:` is a lambda that returns how the program starts. The gem reads
`serve` (`command` and `ready`, `/` when it names none), `env`,
`environments`, and `defaultEnvironments`. It has no `build`, `prepare`,
`setup`, `url`, `lists`, `policy`, or `{events}` yet: run a build
before `bundle exec nuka run`, and prepare state from the `serve` command
itself (`bin/rails db:prepare && bin/rails server` through `sh -c`).

```ruby
Nukadoko.config(
  program: -> {
    {
      serve: { command: "ruby src/server.rb", ready: "/health" },
      env: { PORT: "{port}" },
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
