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
 * steps") or `ctx.call(part, args)` (docs/spec.md "Parts") when the `Step`
 * given is one discovery never registered. Unlike `from` (whose own
 * unregistered-Step mistake is caught statically, before any step runs —
 * src/step/validate-from.ts), both of these name their target only at the
 * call site inside `run()`, so this is the one place that mistake can be
 * caught at all: docs/spec.md "Chaining steps" put it plainly — "an
 * unregistered `Step` is an error where it is found ... `resultOf` can only
 * be caught at the call, where it throws"; `call` refuses the same mistake
 * the same way. A registered step that simply hasn't run yet in this
 * scenario is a different, non-error state (`ctx.resultOf` returns
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
 * mismatched instance like this usually happens", not "which one". One error
 * type, kept to one so a caller only ever needs one `instanceof` check;
 * `callSite` only changes which API name the message opens with, so the two
 * callers read as the same mistake rather than two different ones. */
export class UnregisteredStepError extends Error {
  constructor(callSite: string = "ctx.resultOf()") {
    super(
      `${callSite} was called with a Step object discovery never registered. ` +
        "This almost always means the Step was reached through a different `await import()` " +
        "than the one discovery used, producing a distinct module instance whose export is not " +
        '`===` the one in the vocabulary (docs/spec.md "Chaining steps"). Import the step module ' +
        "the same way its own file does (a plain relative import), rather than a fresh dynamic import.",
    );
    this.name = "UnregisteredStepError";
  }
}

/** Thrown by `ctx.call(part, args)` (docs/spec.md "Parts") when the calling
 * step never listed `part` in its own `parts`. `parts` is declared, not read
 * out of a step's body (src/step/define-step.ts's own header on `parts`
 * explains why: a fixture bag is built before `run()` runs, from a static
 * declaration, never by watching which `call` sites a body happens to
 * reach), so a `Step` this check rejects is refused before it ever runs —
 * the part's own `run` is never called, and nothing about this call is
 * added to the calling step's own `calls` (docs/spec.md "Parts": "`call`
 * refuses a step `parts` does not declare"). `callerName`/`partName` are
 * each the vocabulary name the executor already resolved for them, or a
 * fallback when the given `Step` object was never itself registered
 * (a `partName` that hits that fallback is also about to be caught by
 * `UnregisteredStepError`, but the *declaration* mismatch is checked first
 * — a `part` a step never declared is refused for that reason alone,
 * whether or not it is separately registered). */
export class PartNotDeclaredError extends Error {
  constructor(callerName: string, partName: string) {
    super(
      `Step "${callerName}" called "${partName}" through call(), but does not list it in its own ` +
        '"parts" (docs/spec.md "Parts"). Add it there. The fixture bag this step runs with is ' +
        'built from that list before "run" is called, so a part the list does not name has ' +
        "nothing to run with.",
    );
    this.name = "PartNotDeclaredError";
  }
}

/** Thrown by `ctx.call(part, args)` (docs/spec.md "Parts") when `part`'s own
 * declared `mutates` is `true` and the current environment's `policy` is
 * `"read-only"` — the same refusal `nuka run`/`nuka do` already apply to a
 * step bound directly to a scenario line or named on the command line
 * (run-scenario.ts's read-only branch, cli/do.ts's setup-phase check),
 * closed here for the one path that skipped it: a composite declared
 * `mutates: false` calling a part declared `mutates: true` used to reach
 * the wire under a read-only environment on nothing but its own caller's
 * unrelated declaration, since only the entry step's own `mutates` was ever
 * checked before this. `part.mutates` alone decides this — the calling
 * step's own declaration, and what the part's `run` would actually have
 * done, are both irrelevant to it, the same way a step's own declared
 * `mutates` already overrides everything execution measures (docs/spec.md
 * "Keyword semantics"). `part` never runs: this is a "never began" refusal,
 * the same shape `PartNotDeclaredError`/`UnregisteredStepError` above
 * already have. `message` is built by the caller (create-context.ts's own
 * `refuseMutatingPart` option), from the resolved environment's own name
 * and policy — this class only wraps it, so the wording matches `nuka
 * run`/`nuka do`'s own read-only refusal for a step exactly: same fact,
 * same policy, only the reachability path differs. */
export class ReadOnlyMutatingPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyMutatingPartError";
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
