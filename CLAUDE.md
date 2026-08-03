# CLAUDE.md

Project context for agent sessions working in this repository.

## What this is

nukadoko is an agent-first engine that runs Gherkin: typed step contracts,
tool-measured execution records (receipts), and sign-offs. The design source
of truth is `docs/spec.md` — read it before changing behavior. Status:
pre-0.1; M1 (engine core) and M2 (compat) are implemented, both real-world
gates have been run (typed-step drafting, and the compat audit reported
under docs/spec.md "Compat steps"). Of M3+, the Allure emitter and the
cucumber-messages emitter, sign-off (`nuka accept`), both agent skills, and
compat gap detection in `nuka check` (the migration skill's prerequisite)
are all implemented, closing out M1-M5. M6 (chained arguments) is
implemented too: `from` on `defineStep`, the binding-order check `nuka
check` and `nuka run` share, `nuka do --use`, and `used` naming the step
beside each receipt. Still unimplemented: the AI-assisted glue converter
and scenario harvesting.

## Naming rule

The npm package, this repository, the config file (`nukadoko.config.ts`),
and the state directory (`.nukadoko/`) are all **nukadoko**. The one thing
called **nuka** is the CLI command the package installs. Keep prose and
identifiers on that line.

## Design principles

The reasoning is in `docs/spec.md`; this is the short list to check a
change against before writing it.

- **Declaration and measurement answer different questions.** The tool
  measures what it can measure exactly and trusts a declaration for what it
  cannot. Where the only available measurement is a proxy — HTTP method
  standing in for write semantics — it is recorded beside the declaration
  and never used to overrule it. Do not automate a verdict on top of a
  proxy; a check that is wrong for GraphQL or RPC-over-POST every time is
  worse than no check.
- **The feature file names everything that ran.** Nothing executes that the
  scenario did not ask for. A missing dependency is a mistake to fix in the
  feature, never something the engine inserts quietly to make a run
  succeed — a feature that doesn't account for what ran stops being the
  record this tool exists to keep.
- **A failure a static check can reach belongs to the static check.** If a
  run can only end one way, say so before it starts rather than after
  minutes of browser time. But only when it can *only* end that way: a
  check that guesses is worse than no check, because false positives teach
  people to ignore the true ones. When in doubt, stay silent.
- **Nothing breaks silently.** A mistake either fails loudly or is
  reported. A reference that resolves to nothing must not keep returning
  `undefined` forever with no way to trace it.
- **The migration door stays open.** An existing suite keeps working
  through the switch and through partial migration; compat assets never
  break because half the suite moved on.
- **Thin over official APIs.** `ctx.page()` and `ctx.request()` hand back
  Playwright's own objects. Do not wrap a vendor API in one of our own to
  buy portability nobody asked for — the wrapper costs every capability it
  didn't think to expose.
- **`ctx` carries only what the executor must inject.** A helper that needs
  nothing from the executor is an import, not a context member.
- **A contract says what the step demands.** Not what one caller happens to
  supply, and not a weaker shape adopted to route around a missing
  mechanism. If the schema and the real requirement disagree, the mechanism
  is what should change.

## Hard rules

- Dependencies are exact-pinned. Adding, removing, or changing a version
  requires the user's explicit approval first (their policy: release must be
  7+ days old with no superseding security fix). Never loosen a pin.
- Never run `npm publish` or any outward, irreversible operation (registry,
  visibility, deploys). Prepare the state and let the user execute.
- Commits are semantic units, in English, matching the existing message
  style; the user reviews direction, the session reviews code.
- Paired files are kept in sync: README.md/README.ja.md,
  docs/spec.md/docs/spec.ja.md, docs/migration.md/docs/migration.ja.md
  (Japanese: one sentence per line; the English file is the source of
  truth).
- **A change to the CLI surface, to a step's contract, or to what `check`
  catches is not finished until `skills/` says so too.** The skills are how
  a user actually reaches a feature, so a skill describing the previous CLI
  teaches the previous CLI — the feature ships and nobody can find it. Both
  need checking on every such change: `skills/acceptance/SKILL.md` (write a
  scenario, run it, sign it off) and `skills/migration/SKILL.md` (move an
  existing cucumber-js suite across). Skills never copy a fact the CLI
  itself answers — vocabulary, contracts, refusal reasons go stale the
  moment a command changes — but they must name the commands, flags, and
  checks that exist, and must not name ones that don't.
- Code comments explain why, not what; each module opens with its
  responsibility and boundaries.
