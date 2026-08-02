import { defineConfig } from "./nukadoko-shim.js";

// Two config.parameterTypes entries, each answering one docs/spec.md example
// verbatim (m2pre-parameter-types task spec, scope item 2):
//
// - `negation`: docs/spec.md's own boolean-polarity example — the
//   `( not)?` regexp's own capturing group is either empty-participating
//   (" not") or non-participating (`undefined`) when it doesn't match;
//   either way `s === " not"` is exactly the right comparison, no `?? ""`
//   needed. Used directly by tests/parameter-types.test.ts's own matching
//   pipeline (features/steps/thing-will-return.ts) — deliberately not
//   referenced from any .feature file here, since that test exercises
//   matching/binding/zod directly rather than through `nuka run`/`nuka
//   check` (`nuka do` addresses a step by name, never by matching pattern
//   text, so there is no CLI path that would need one).
// - `from-dir`: docs/spec.md's "the same step with a trailing location
//   clause" example — folds "list items" and "list items from '<dir>'"
//   into features/steps/list-items.ts's one pattern, proven end to end by
//   features/from-dir.feature (`nuka check` green, `nuka run` executing
//   both scenarios) rather than needing two near-identical step
//   definitions.
export default defineConfig({
  parameterTypes: [
    {
      name: "negation",
      regexp: /( not)?/,
      transformer: (s: string) => s === " not",
    },
    {
      name: "from-dir",
      regexp: /( from '[^']*')?/,
      transformer: (s: string | undefined) => {
        if (s === undefined) {
          return undefined;
        }
        const match = /^ from '([^']*)'$/.exec(s);
        return match ? match[1] : undefined;
      },
    },
  ],
});
