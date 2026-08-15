// Responsibility: errors specific to compat's own *runtime* surface (World,
// hooks) — as opposed to compat *registration* errors (duplicate pattern),
// which live in src/discover/errors.ts alongside their typed-step
// counterparts, since those are discovery-time concerns.
//
// `WORLD_WRITE_VALIDATION_ERROR_BRAND` exists because `instanceof
// WorldWriteValidationError` cannot be relied on at that error's own usual
// catch site (src/run/run-scenario.ts): a
// compat step's own defineWorld-declared write throws from inside src/
// compat/world-instrumentation.ts, reached through src/compat/world.ts —
// which discovery loads through its own scoped tsx import, a *different*
// module instance of this exact file than the one run-scenario.ts's plain
// top-level `import` resolves to (src/discover/discover-steps.ts's own
// header). Same fix as src/step/brand.ts's own `STEP_BRAND`, verified the
// same empirical way that file's header describes: `Symbol.for` reads from
// the process-wide symbol registry, shared across module graphs in the same
// process, so a plain own-property keyed on it survives a boundary a
// class-identity check does not.

/** `World.page`/`World.request` are synchronous getters on purpose: they
 * must not silently return `undefined` when the matching `openPage()`/
 * `openRequest()` hasn't resolved yet, since a step that forgot to `await`
 * it would otherwise fail confusingly deep inside its own logic instead of
 * at the point of the mistake. */
export class WorldNotOpenedError extends Error {
  readonly member: "page" | "request";

  constructor(member: "page" | "request") {
    const opener = member === "page" ? "openPage" : "openRequest";
    super(
      `World.${member} was accessed before ${opener}() resolved; call \`await this.${opener}()\` first`,
    );
    this.name = "WorldNotOpenedError";
    this.member = member;
  }
}

/** A Before/After hook's own `{ tags }` option used something other than a
 * single `@tag` or its negation `not @tag` (src/compat/tag-expression.ts) —
 * v1's deliberately small subset of Cucumber's tag expression grammar: any
 * other expression is a setup error that states plainly it's unsupported.
 * Named "unsupported", not "invalid": the expression may
 * well be valid Cucumber tag expression syntax elsewhere (`and`/`or`/
 * parentheses) — nukadoko just doesn't implement it yet, and a silent
 * partial match would be worse than refusing outright. */
export class UnsupportedTagExpressionError extends Error {
  readonly expression: string;

  constructor(expression: string) {
    super(
      `Unsupported hook tag expression "${expression}": v1 supports only a single "@tag" or its negation "not @tag", not Cucumber's full tag expression grammar (and/or/parentheses)`,
    );
    this.name = "UnsupportedTagExpressionError";
    this.expression = expression;
  }
}

/** `this.<reserved>` was reassigned at run time (a throwaway prototype
 * measured this) — `attach`/`log`/`link`/`parameters` are, in cucumber-js
 * itself, ordinary writable own data properties despite being typed
 * `readonly` upstream, so
 * nothing but this explicit guard would stop `this.attach = "oops"` from
 * silently replacing the real function and only failing later, confusingly,
 * inside whatever glue code next calls `this.attach(...)`. */
export class ReservedWorldKeyWriteError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`World.${key} is a reserved cucumber-js field and cannot be reassigned at run time`);
    this.name = "ReservedWorldKeyWriteError";
    this.key = key;
  }
}

/** A `defineWorld` schema named one of the reserved keys — registration-time,
 * not run-time: this must be caught before the schema is ever installed,
 * the same way it would make no sense
 * to let a schema silently govern a field the harness itself already owns. */
export class ReservedWorldKeyDeclaredError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`defineWorld cannot declare "${key}": it is a reserved cucumber-js World field`);
    this.name = "ReservedWorldKeyDeclaredError";
    this.key = key;
  }
}

/** A declared-key write failed its own `defineWorld` zod schema — thrown
 * from inside the accessor's own setter
 * (src/compat/world-instrumentation.ts), so it becomes an ordinary step
 * failure exactly like any other throw from a compat step's own glue
 * function; the write is never recorded into the step record's own
 * `world.writes` (thrown before that record happens — a throwaway prototype
 * measured this bug, regularized into this module's own contract). */
const WORLD_WRITE_VALIDATION_ERROR_BRAND: unique symbol = Symbol.for(
  "nukadoko.worldWriteValidationError",
);

export class WorldWriteValidationError extends Error {
  readonly key: string;
  readonly [WORLD_WRITE_VALIDATION_ERROR_BRAND] = true;

  constructor(key: string, issues: string) {
    super(`World.${key} failed its declared defineWorld schema: ${issues}`);
    this.name = "WorldWriteValidationError";
    this.key = key;
  }
}

/**
 * True for any `WorldWriteValidationError`, from any module realm — the
 * brand-based counterpart to `instanceof WorldWriteValidationError`, safe to
 * call from a catch site that may not share this exact class (this file's
 * own header explains why that happens). Deliberately not `error instanceof
 * Error && error.name === "WorldWriteValidationError"`: `name` is settable
 * by any code that happens to construct a plain `Error` and reassign it, so
 * it is not a reliable brand on its own the way a `Symbol.for`-keyed
 * own-property is.
 */
export function isWorldWriteValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[WORLD_WRITE_VALIDATION_ERROR_BRAND] === true
  );
}

/** A compat step's or hook's own `{ timeout }` (or the run's own
 * `setDefaultTimeout`) fired before `run()` settled (`runWithTimeout`,
 * src/run/run-scenario.ts). Its own class, not a plain `Error`, exists for
 * one reason: make it identifiable at the point it's thrown, before
 * classification. The catch site that turns this into a step record's/hook
 * record's `error.kind`
 * needs to tell a timeout apart from the step's/hook's own throw by type,
 * never by matching `message`'s text — that text is for humans and this
 * file's own `timeoutMessage` (run-scenario.ts) is free to keep changing it. */
export class CompatTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatTimeoutError";
  }
}
