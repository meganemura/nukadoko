# CLAUDE.md

Project context for agent sessions working in this repository.

## What this is

nukadoko is an agent-first engine that runs Gherkin: typed step contracts,
tool-measured execution records (receipts), and sign-offs. The design source
of truth is `docs/spec.md` — read it before changing behavior. Status:
pre-0.1; M1 (engine core) is implemented, the real-world validation gate
(docs/spec.md, Implementation notes) is next, and M2+ are design-only.

## Naming rule

The npm package, this repository, the config file (`nukadoko.config.ts`),
and the state directory (`.nukadoko/`) are all **nukadoko**. The one thing
called **nuka** is the CLI command the package installs. Keep prose and
identifiers on that line.

## Hard rules

- Dependencies are exact-pinned. Adding, removing, or changing a version
  requires the user's explicit approval first (their policy: release must be
  7+ days old with no superseding security fix). Never loosen a pin.
- Never run `npm publish` or any outward, irreversible operation (registry,
  visibility, deploys). Prepare the state and let the user execute.
- Commits are semantic units, in English, matching the existing message
  style; the user reviews direction, the session reviews code.
- README.md/README.ja.md and docs/spec.md/docs/spec.ja.md are kept in sync
  (Japanese: one sentence per line; the English file is the source of
  truth).
- Code comments explain why, not what; each module opens with its
  responsibility and boundaries.
