import type { FixtureConsumer } from "./fixture-names.js";

// Responsibility: a best-effort, lexical-only guess at which fixtures an
// unmigrated step's run() touches — read only after `fixtureParameterNames`
// (src/step/fixture-names.ts) has already thrown for that step's `run`.
// This is inventory, never a contract: the caller is the one
// place that decides whether to surface this at all, and it must only ever
// land in a field of its own (`needs_inferred`), never merged into `needs`
// itself (the one thing this whole feature
// exists to keep separate). Nothing here decides `needs_browser` either;
// this file states no fact it cannot back with a contract.
//
// Measured against 68 steps already migrated on main: scanning a
// pre-migration step's source text for
// `<firstArgumentName>.<member>` (plus its optional-chaining and
// destructuring variants below), filtered down to known fixture names,
// matched all 68 migrated `needs` lists exactly, zero false positives, zero
// false negatives. That same measurement names two shapes this scan still
// misses
// on purpose (an alias — `const c = ctx; c.page()` — needs real AST
// tracking, which is out of scope for a lexical scan):
// documented here rather than silently accepted, and the caller (src/cli/
// vocabulary.ts) is the one that keeps this fact visible to a reader
// instead of quietly treating an inferred list as complete.

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ScanState = "code" | "line-comment" | "block-comment" | "single-quote" | "double-quote" | "template";

/**
 * Removes every comment, string literal, and template literal from
 * `source` in a single combined pass — stripping comments and literals as
 * two separate passes each corrupts the other (an apostrophe inside `//
 * comment` would start a fake string if literals were stripped after
 * comments; `//` inside a string would start a fake comment if stripped
 * before literals were). Comment/literal contents are simply omitted
 * (never replaced by anything) — the same behavior fixture-names.ts's own
 * `filterOutComments` gives a step's parameter-list text; this is that same
 * idea widened to cover a whole function body, since this module has to
 * scan wherever `<name>.<member>` can legally appear, not just the
 * signature. Not shared with fixture-names.ts's own copy on purpose:
 * modifying that file's already-working success path was out of scope
 * here, and its version has no reason to know about
 * string/template literals at all — it only ever reads a parameter list,
 * never a function body.
 *
 * The one false positive measured here was a plain string literal
 * (`"see ctx.page"`); a template literal's own `${...}` interpolation is
 * stripped along with the rest of it here rather than preserved, which
 * wasn't measured against and isn't claimed to be caught — a fixture
 * genuinely referenced only inside one is a miss, the same kind of gap as
 * an alias (this file's own header).
 */
function stripCommentsAndLiterals(source: string): string {
  let result = "";
  let state: ScanState = "code";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (state === "line-comment") {
      if (ch === "\n") {
        state = "code";
        result += ch;
      }
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state === "single-quote" || state === "double-quote" || state === "template") {
      if (ch === "\\") {
        i += 1; // skip whatever the escape covers, quote or not
        continue;
      }
      if (
        (state === "single-quote" && ch === "'") ||
        (state === "double-quote" && ch === '"') ||
        (state === "template" && ch === "`")
      ) {
        state = "code";
      }
      continue;
    }
    // state === "code"
    if (ch === "/" && next === "/") {
      state = "line-comment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "single-quote";
      continue;
    }
    if (ch === '"') {
      state = "double-quote";
      continue;
    }
    if (ch === "`") {
      state = "template";
      continue;
    }
    result += ch;
  }
  return result;
}

/** One destructured prop's own name, `const { page: p, poll = x } = ctx`'s
 * `page`/`poll` — the property being read off the aliased whole-argument
 * binding, never the local alias/default a caller happens to give it,
 * mirroring fixture-names.ts's own `computeFixtureNames` prop-name rule for
 * the same reason (a fixture name is a contract-shaped fact about `ctx`
 * itself, not about whatever a step chose to call it locally). */
function destructuredPropName(prop: string): string | undefined {
  const trimmed = prop.trim();
  if (!trimmed) {
    return undefined;
  }
  const name = trimmed.split(/[:=]/, 1)[0]!.trim();
  return name || undefined;
}

/**
 * A best-effort guess at the fixture names `fn`'s own body touches through
 * its first argument, named `firstArgumentName` (the same bare identifier
 * `FixtureNotDestructuredError.firstArgumentText` already carries for a
 * step whose `run()` was never migrated to destructuring at all —
 * `run(ctx, args)`'s own `"ctx"`). `fn` is never called, only read via
 * `.toString()`, same as every other reader in src/step/fixture-names.ts.
 *
 * Scans for three shapes only (see this file's own header):
 * `name.member`, `name?.member` (optional chaining), and
 * `const { a, b } = name` (destructuring an alias for the whole first
 * argument somewhere in the body) — then keeps only names present in
 * `knownFixtureNames`, so a step's own non-fixture helper call
 * (`ctx.someHelper()`) never leaks into the result (this file's own header:
 * this narrows what a false positive could even be shaped like).
 *
 * Returns `undefined`, not `[]`, when `firstArgumentName` itself isn't a
 * plain identifier this scan could key a search on at all — nothing was
 * attempted, so the caller reads this the same as "couldn't infer" rather
 * than "inferred nothing" (a reader must be able to tell the two apart,
 * never silently folded into one).
 */
export function inferNeeds(
  fn: FixtureConsumer,
  firstArgumentName: string,
  knownFixtureNames: ReadonlySet<string>,
): readonly string[] | undefined {
  const name = firstArgumentName.trim();
  if (!IDENTIFIER_RE.test(name)) {
    return undefined;
  }

  const text = stripCommentsAndLiterals(fn.toString());
  const escaped = escapeForRegExp(name);
  const found = new Set<string>();

  const memberAccessPattern = new RegExp(`\\b${escaped}\\??\\.(\\w+)`, "g");
  for (const match of text.matchAll(memberAccessPattern)) {
    found.add(match[1]!);
  }

  const destructurePattern = new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*${escaped}\\b`, "g");
  for (const match of text.matchAll(destructurePattern)) {
    for (const prop of match[1]!.split(",")) {
      const propName = destructuredPropName(prop);
      if (propName !== undefined) {
        found.add(propName);
      }
    }
  }

  return [...found].filter((candidate) => knownFixtureNames.has(candidate)).sort();
}
