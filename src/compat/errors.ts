// Responsibility: errors specific to compat's own *runtime* surface (World,
// hooks) — as opposed to compat *registration* errors (duplicate pattern),
// which live in src/discover/errors.ts alongside their typed-step
// counterparts, since those are discovery-time concerns.

/** `World.page`/`World.request` are synchronous getters on purpose (m2b-
 * compat-execution task spec, decision 1, lead-arbitrated two-tier design):
 * they must not silently return `undefined` when the matching `openPage()`/
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
 * v1's deliberately small subset of Cucumber's tag expression grammar
 * (m2b-compat-execution task spec, item 5: "それ以外の式はセットアップエラーで
 * 「未対応」を明言"). Named "unsupported", not "invalid": the expression may
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

/** `this.<reserved>` was reassigned at run time (m2c-typed-world task spec,
 * item 1's reserved-key deny-list; proto-typed-world/findings.md Q5) —
 * `attach`/`log`/`link`/`parameters` are, in cucumber-js itself, ordinary
 * writable own data properties despite being typed `readonly` upstream, so
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

/** A `defineWorld` schema named one of the reserved keys (m2c-typed-world
 * task spec, item 1) — registration-time, not run-time: this must be caught
 * before the schema is ever installed, the same way it would make no sense
 * to let a schema silently govern a field the harness itself already owns. */
export class ReservedWorldKeyDeclaredError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`defineWorld cannot declare "${key}": it is a reserved cucumber-js World field`);
    this.name = "ReservedWorldKeyDeclaredError";
    this.key = key;
  }
}

/** A declared-key write failed its own `defineWorld` zod schema (m2c-typed-
 * world task spec, item 2) — thrown from inside the accessor's own setter
 * (src/compat/world-instrumentation.ts), so it becomes an ordinary step
 * failure exactly like any other throw from a compat step's own glue
 * function; the write is never recorded into `receipt.world.writes` (thrown
 * before that record happens — proto-typed-world/findings.md Q1's bug,
 * regularized into this module's own contract). */
export class WorldWriteValidationError extends Error {
  readonly key: string;

  constructor(key: string, issues: string) {
    super(`World.${key} failed its declared defineWorld schema: ${issues}`);
    this.name = "WorldWriteValidationError";
    this.key = key;
  }
}
