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
