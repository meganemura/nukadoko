// Responsibility: read a step's `run` function's own declared fixture names
// — the first argument's object-destructuring pattern — from `fn.toString()`,
// without ever calling the function (p4a-fixture-bag task spec). This is
// what lets `nuka check` treat a step's fixture needs as a static fact,
// and what lets `nuka run`/`nuka do` build only the resources a step's own
// `run({ page, section }, args)` actually names.
//
// Modeled on Playwright's own `fixtureParameterNames` (source read at
// node_modules/playwright/lib/common/index.js, version 1.61.1, MIT License,
// (c) Microsoft Corporation) — same regex-based split of the source text
// into a parameter list, same "first argument must be `{...}`", same
// "`...rest` is refused" rule. Rewritten here rather than imported, for two
// reasons this task's spec calls out: (1) Playwright's own version reports a
// broken pattern through an `onError` callback rather than throwing, and
// this file wants real `Error` subclasses a caller can `instanceof`, the
// same convention every other error type in this package follows
// (src/context/errors.ts, src/config/errors.ts, ...); (2) its own
// memoization key is an internal `Symbol("signature")` this package has no
// business reaching for — a plain `WeakMap` here needs no `require` of any
// Playwright-internal symbol at all (this task's spec: "内部シンボルを
// require しない").
//
// A default value breaks this kind of extraction (this task's spec,
// "前提", measured against the same Playwright source above):
// `{ page = null }` parses to the single, useless name `"page=null"`;
// `{ page = fn(a, b) }` corrupts even further, since neither this file's own
// `splitByComma` below nor Playwright's tracks `(`/`)` nesting, so the comma
// inside `fn(a, b)` splits the destructuring apart mid-expression. Rather
// than silently hand a caller a broken or partial name list, every prop
// containing `=` refuses outright (`FixtureDefaultValueError`) — a default
// value is meaningless for a fixture anyway (a fixture is always present
// once its name is destructured), so nothing legitimate is lost by
// forbidding it.
//
// nukadoko only ever loads step files (and config) through tsx's own
// `register().import()` (src/discover/discover-steps.ts) or `tsImport`
// (src/config/load-config.ts) — never plain Node ESM/CJS loading — so this
// file's only real dependency is tsx's own esbuild transform producing
// `fn.toString()` text shaped the way this parser expects. The regression
// test (tests/fixture-names.test.ts) loads a representative step through
// that exact path and asserts the names extracted match — the guard against
// tsx's own default transform changing shape silently out from under this
// file.

/** Thrown when a step's `run` function's first argument is not an
 * object-destructuring pattern (`{ ... }`) at all — a bare identifier
 * (`run(ctx, args)`), a default parameter, or no first argument spelled out
 * as one. nukadoko needs the pattern itself to read fixture names from
 * without calling `run`; a positional parameter has no name it could read
 * that way. */
export class FixtureNotDestructuredError extends Error {
  readonly firstArgumentText: string;

  constructor(firstArgumentText: string) {
    super(
      `A step's run() must destructure its first argument (e.g. "{ page, section }"), ` +
        `not "${firstArgumentText}": nukadoko reads which fixtures a step needs from that ` +
        `pattern, without ever calling run() (docs/spec.md "Context API")`,
    );
    this.name = "FixtureNotDestructuredError";
    this.firstArgumentText = firstArgumentText;
  }
}

/** Thrown when a destructured fixture prop carries a default value
 * (`{ page = ... }`) — this file's own header explains why the extraction
 * itself breaks on this shape; refusing outright is safer than handing back
 * a broken or partial name list and misdiagnosing "fixture not found" for
 * something else entirely. */
export class FixtureDefaultValueError extends Error {
  readonly prop: string;

  constructor(prop: string) {
    super(
      `A step's run() fixture destructuring cannot use a default value ("${prop}"): nukadoko ` +
        `reads fixture names by parsing run()'s own source text, and a default value breaks that ` +
        `parsing. A fixture is always present once it's named, so remove the default`,
    );
    this.name = "FixtureDefaultValueError";
    this.prop = prop;
  }
}

/** Thrown when a destructured fixture prop is a rest property
 * (`{ ...rest }`) — a rest property's own bound names are not knowable
 * without running the destructuring, which nukadoko must not do just to
 * read what a step needs. */
export class FixtureRestParameterError extends Error {
  readonly prop: string;

  constructor(prop: string) {
    super(
      `A step's run() fixture destructuring cannot use a rest property ("${prop}"): every ` +
        `fixture a step needs must be named explicitly, so nukadoko can read the full list ` +
        `statically, without running the step (docs/spec.md "Context API")`,
    );
    this.name = "FixtureRestParameterError";
    this.prop = prop;
  }
}

/** Any function shape a `Step.run` (or a test double standing in for one)
 * can take — this file never calls `fn`, only reads its `toString()`, so
 * the parameter/return types themselves are irrelevant here. */
export type FixtureConsumer = (...args: never[]) => unknown;

/** Comments-out `//` and `/* ... *\/` the same way `fn.toString()`'s own
 * text can carry them (Playwright's own `filterOutComments`, mirrored here
 * per this file's own header) — so a fixture name that happens to appear
 * inside a comment on the same line as the destructuring is never read as
 * real. */
function filterOutComments(source: string): string {
  let result = "";
  let state: "none" | "singleline" | "multiline" = "none";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (state === "singleline") {
      if (ch === "\n") {
        state = "none";
      }
      continue;
    }
    if (state === "multiline") {
      if (source[i - 1] === "*" && ch === "/") {
        state = "none";
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      state = "singleline";
    } else if (ch === "/" && source[i + 1] === "*") {
      state = "multiline";
      i += 1;
    } else {
      result += ch;
    }
  }
  return result;
}

/** Splits `text` on top-level commas only — `{`/`[` nesting is tracked,
 * `(` is not (Playwright's own `splitByComma`, mirrored here). That last
 * gap is exactly this file's own header's "実測": a default value's own
 * function call, `{ page = fn(a, b) }`, has a top-level-looking comma
 * inside `fn(...)` that this function cannot tell apart from a second
 * destructured prop — which is why a default value is refused outright by
 * the caller rather than parsed further once found. */
function splitByComma(text: string): string[] {
  const result: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
    } else if (stack.length === 0 && ch === ",") {
      const token = text.slice(start, i).trim();
      if (token) {
        result.push(token);
      }
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) {
    result.push(last);
  }
  return result;
}

function computeFixtureNames(fn: FixtureConsumer): readonly string[] {
  const text = filterOutComments(fn.toString());
  const match = text.match(/(?:async)?(?:\s+function)?[^(]*\(([^)]*)/);
  if (!match) {
    return [];
  }
  const trimmed = (match[1] ?? "").trim();
  if (!trimmed) {
    // A step whose run() takes no arguments at all — spec's own "引数を1つ
    // も取らない関数も許す": it needs no fixtures.
    return [];
  }
  const [firstArgument] = splitByComma(trimmed);
  const arg = firstArgument ?? "";
  if (arg[0] !== "{" || arg[arg.length - 1] !== "}") {
    throw new FixtureNotDestructuredError(arg);
  }
  const props = splitByComma(arg.slice(1, -1));
  const names: string[] = [];
  for (const prop of props) {
    if (prop.startsWith("...")) {
      throw new FixtureRestParameterError(prop);
    }
    if (prop.includes("=")) {
      throw new FixtureDefaultValueError(prop);
    }
    const colon = prop.indexOf(":");
    const name = (colon === -1 ? prop : prop.slice(0, colon)).trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
}

const cache = new WeakMap<FixtureConsumer, readonly string[]>();

/**
 * The fixture names `fn` (a `Step.run`) destructures from its own first
 * argument — `[]` for a function that takes no arguments, or an empty
 * object pattern (`async ({}, args) => ...`). Memoized per function
 * reference, so a caller that asks more than once (`nuka check` and `nuka
 * run` sharing this same judgment, this task's spec) re-parses the source
 * text exactly once.
 *
 * @throws {FixtureNotDestructuredError} the first argument isn't an object
 * pattern (`{ ... }`).
 * @throws {FixtureDefaultValueError} a destructured prop carries a default
 * value.
 * @throws {FixtureRestParameterError} a destructured prop is a rest
 * property.
 */
export function fixtureParameterNames(fn: FixtureConsumer): readonly string[] {
  const cached = cache.get(fn);
  if (cached !== undefined) {
    return cached;
  }
  const names = computeFixtureNames(fn);
  cache.set(fn, names);
  return names;
}
