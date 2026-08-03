// Responsibility: the error type `ctx.requireEnv` raises, kept separate from
// create-context.ts so callers (steps, tests) can `instanceof` it without
// pulling in that module's browser/request/session wiring — same convention
// as config/errors.ts, discover/errors.ts, environment/errors.ts,
// session/errors.ts, run/errors.ts.

/** Thrown by `ctx.requireEnv(name)` (docs/spec.md "Context API") when `name`
 * has no value in `ctx.env`, or its value is the empty string. Empty string
 * is treated the same as "not set", not merely `undefined` (t2-require-env
 * task spec, decision 1): an envFile line like `KEY=` (no value after `=`)
 * parses to `""`, not "key omitted" (context/env.ts's `parseEnvFile`), and a
 * step that got `""` back from a key it declared required is exactly as
 * broken as one that got `undefined` — silently proceeding with an empty
 * value is never what "I require this env var" means.
 *
 * The message names the key only, never a value: there is no value to show
 * for a missing key, and keeping the shape value-free means this error can
 * never become a future redaction gap (t2-require-env task spec, decision
 * 3). It also cannot name which envFile to edit — `ctx` itself has no
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
