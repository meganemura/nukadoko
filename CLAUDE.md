# CLAUDE.md

Project context for agent sessions working in this repository.

## What this is

nukadoko is an agent-first engine that runs Gherkin: typed step contracts,
tool-measured execution records (receipts), and sign-offs. The design source
of truth is `docs/spec.md` — read it before changing behavior. Status:
pre-0.1, milestone M1 (engine core) in progress.

## Naming rule

The npm package, this repository, the config file (`nukadoko.config.ts`),
and the state directory (`.nukadoko/`) are all **nukadoko**. The one thing
called **nuka** is the CLI command the package installs. Keep prose and
identifiers on that line.

## Session-to-session state

Current status and the next planned action live in `.claude-team/HANDOFF.md`
(untracked; may be absent in a fresh clone). Task specs for implementer
subagents live under `.claude-team/<task-slug>/spec.md`. Read the handoff
before starting work.

## Hard rules

- Dependencies are exact-pinned. Adding, removing, or changing a version
  requires the user's explicit approval first (their policy: release must be
  7+ days old with no superseding security fix). Never loosen a pin.
- Never run `npm publish` or any outward, irreversible operation (registry,
  visibility, deploys). Prepare the state and let the user execute.
- The published `nukadoko@0.0.0` placeholder deliberately reveals nothing
  about the project. Anything that would become publicly visible on npm
  stays neutral until the first real release (note: `files: []` in
  package.json is placeholder-era and must become `["dist"]` before that
  release).
- Commits are semantic units, in English, matching the existing message
  style; the user reviews direction, the session reviews code.
- README.md and README.ja.md are kept in sync (Japanese: one sentence per
  line). Code comments explain why, not what; each module opens with its
  responsibility and boundaries.
