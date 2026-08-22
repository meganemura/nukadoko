# Contributing

## Setup

```sh
npm ci
npx playwright install chromium
```

The second command is not optional. `npm ci` never fetches browsers: the
`playwright` package declares no install script, and the browsers live in a
shared cache outside `node_modules` that only `playwright install` fills. If
one is already there from another project, the tests pass without this step
and you will not learn that you skipped it. On a clean machine they fail
with Playwright's own message telling you to run it.

Chromium is the only browser the suite launches. Two tests name `firefox`
in a config, and neither starts one: they check what a sign-off record
writes down about which browser was declared.

`ignore-scripts` is on because every npm supply-chain compromise this year
arrived through an install hook in a package nobody chose directly, running
before anyone had read it. Exactly one dependency here declares one, and the
build and the tests were measured without it.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Builds, then runs the unit and CLI tests |
| `npm run selftest` | Builds, then runs the suite against itself, with a browser |
| `npm run typecheck` | Type-checks sources and tests together, no build needed |
| `npm run coverage` | Builds, then runs the tests with coverage |
| `npm run build` | Compiles `src/` to `dist/` |

Every command above that needs a build runs it in its own body rather than
through npm's `pretest` hook, because `ignore-scripts` turns those hooks off
too. A build step that silently does not run is worse than no build step,
and this repository has been caught by that twice.

## Releasing

Build before publishing, in a separate command:

```sh
npm run build
npm publish
```

`package.json` declares `prepublishOnly`, and with `ignore-scripts` on it
does not fire. Publishing without building first ships whatever `dist/`
happened to be there, which may be older than `src/` or missing entirely.
The explicit build is what guarantees the tarball matches the commit.

## Conventions

`AGENTS.md` holds the rules that a change is checked against: which
documents are paired with a Japanese twin, how the glossary settles a term,
what a comment is allowed to cite, and why the prose here carries no
em-dashes. `docs/spec.md` is where design decisions live, and it is worth
reading before changing behavior.
