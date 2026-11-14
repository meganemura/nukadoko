import { UnsupportedTagExpressionError } from "./errors.js";

// Responsibility: the v1 subset of Cucumber's tag expression grammar
// nukadoko commits to — a single `@tag`, or its negation
// `not @tag` — applied to a Before/After hook's own `{ tags }` option
// against one pickle's own tags. Anything else (`and`/`or`/parentheses) is a
// setup error naming itself unsupported (UnsupportedTagExpressionError),
// rather than a silent (and possibly wrong) partial match — an explicit
// refusal beats a silent mismatch.

interface ParsedTagExpression {
  readonly negate: boolean;
  readonly tag: string;
}

const NOT_PATTERN = /^not\s+(@\S+)$/;
const TAG_PATTERN = /^@\S+$/;

/** @throws {UnsupportedTagExpressionError} `expression` is neither a bare
 *   `@tag` nor `not @tag`. */
function parseTagExpression(expression: string): ParsedTagExpression {
  const trimmed = expression.trim();
  const notMatch = NOT_PATTERN.exec(trimmed);
  if (notMatch) {
    return { negate: true, tag: notMatch[1]! };
  }
  if (TAG_PATTERN.test(trimmed)) {
    return { negate: false, tag: trimmed };
  }
  throw new UnsupportedTagExpressionError(expression);
}

/**
 * Validated once, up front, for every registered hook that has a `tags`
 * option (src/cli/run.ts's setup phase) — an unsupported tag expression is a
 * setup failure the same way a `config.parameterTypes` name collision is:
 * the expression's own syntax is either supported or
 * not, independent of which pickle a run happens to execute; discovering it
 * only when a matching pickle comes along would make the failure appear to
 * depend on scenario selection, which it doesn't.
 * @throws {UnsupportedTagExpressionError}
 */
export function validateTagExpression(expression: string): void {
  parseTagExpression(expression);
}

/**
 * Whether a hook whose own `{ tags }` option is `expression` applies to a
 * pickle carrying `pickleTags` (its own tag names, e.g. `["@smoke"]`).
 * `undefined` (no `tags` option at all) always applies — an untagged
 * Before/After hook runs for every scenario, same as cucumber-js.
 * @throws {UnsupportedTagExpressionError} same as `validateTagExpression` —
 *   callers that already validated every hook up front (src/cli/run.ts)
 *   never actually hit this a second time; kept here too so this function is
 *   safe to call on its own.
 */
export function hookApplies(expression: string | undefined, pickleTags: readonly string[]): boolean {
  if (expression === undefined) {
    return true;
  }
  const { negate, tag } = parseTagExpression(expression);
  const has = pickleTags.includes(tag);
  return negate ? !has : has;
}
