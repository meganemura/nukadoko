// Responsibility: the error type `ctx.requireEnv` raises, kept separate from
// create-context.ts so callers (steps, tests) can `instanceof` it without
// pulling in that module's browser/request/session wiring — same convention
// as config/errors.ts, discover/errors.ts, environment/errors.ts,
// session/errors.ts, run/errors.ts.

/** Thrown by `ctx.requireEnv(name)` (docs/spec.md "Context API") when `name`
 * has no value in `ctx.env`, or its value is the empty string. Empty string
 * is treated the same as "not set", not merely `undefined`: an envFile
 * line like `KEY=` (no value after `=`)
 * parses to `""`, not "key omitted" (context/env.ts's `parseEnvFile`), and a
 * step that got `""` back from a key it declared required is exactly as
 * broken as one that got `undefined` — silently proceeding with an empty
 * value is never what "I require this env var" means.
 *
 * The message names the key only, never a value: there is no value to show
 * for a missing key, and keeping the shape value-free means this error can
 * never become a future redaction gap. It also cannot name which envFile to
 * edit — `ctx` itself has no
 * visibility into `config.envFiles` (create-context.ts never receives the
 * list, only the already-merged result) — so the message points at
 * `nukadoko.config.ts`'s `envFiles` setting in general rather than guessing
 * a path. */
export class MissingEnvError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `ctx.requireEnv("${key}") found no value: set "${key}" in one of the project's configured envFiles (nukadoko.config.ts's "envFiles")`,
    );
    this.name = "MissingEnvError";
    this.key = key;
  }
}

/** Thrown by `ctx.resultOf(step)` (docs/spec.md "Context API"/"Chaining
 * steps") when `step` is a `Step` object discovery never registered.
 * Unlike `from` (whose own unregistered-Step
 * mistake is caught statically, before any step runs — src/step/
 * validate-from.ts), `resultOf` names its upstream only at the call site
 * inside `run()`, so this is the one place that mistake can be caught at
 * all: docs/spec.md "Chaining steps" put it plainly — "an unregistered
 * `Step` is an error where it is found ... `resultOf` can only be caught at
 * the call, where it throws". A registered step that simply hasn't run yet
 * in this scenario is a different, non-error state (`ctx.resultOf` returns
 * `undefined` for that, never throws) — this error exists only for a `Step`
 * object that isn't `===` anything discovery ever put in the vocabulary at
 * all, which is almost always the sign of a step file reached through a
 * second `await import()` of the same file (a distinct module instance with
 * its own, different `Step` object — see src/discover/discover-steps.ts's
 * own header for why discovery goes out of its way to prevent this for its
 * own loads, and tests/resultof.test.ts for the empirical proof that a step
 * file's ordinary relative import does not hit this). The message names
 * that possibility rather than the step itself: unlike `MissingEnvError`,
 * there is no key to single out — a `Step` carries no name of its own (only
 * discovery's vocabulary key does), so the actionable fact here is "how a
 * mismatched instance like this usually happens", not "which one". */
export class UnregisteredStepError extends Error {
  constructor() {
    super(
      "ctx.resultOf() was called with a Step object discovery never registered. " +
        "This almost always means the Step was reached through a different `await import()` " +
        "than the one discovery used, producing a distinct module instance whose export is not " +
        '`===` the one in the vocabulary (docs/spec.md "Chaining steps"). Import the step module ' +
        "the same way its own file does (a plain relative import), rather than a fresh dynamic import.",
    );
    this.name = "UnregisteredStepError";
  }
}

/** Thrown by `ctx.evidence.attach(name, body)`/`ctx.evidence.path(name)`
 * (docs/spec.md "Context API") when `name` could resolve outside this
 * execution's own evidence directory — a path separator (`/` or `\`), the
 * bare segments `"."`/`".."`, or the empty string. Refused, never
 * sanitized — a name silently rewritten to
 * something else would leave a step trusting a file it never actually
 * asked for, and a step naming a path it should not have named is exactly
 * the kind of mistake CLAUDE.md's "nothing breaks silently" asks to fail
 * loudly rather than be quietly corrected. */
export class InvalidEvidenceNameError extends Error {
  readonly evidenceName: string;

  constructor(name: string) {
    super(
      `ctx.evidence name ${JSON.stringify(name)} is not allowed: it must not contain "/" or "\\", ` +
        'and must not be ".", "..", or empty. Every attachment/path is always written inside this ' +
        "execution's own evidence directory, never elsewhere.",
    );
    this.name = "InvalidEvidenceNameError";
    this.evidenceName = name;
  }
}
