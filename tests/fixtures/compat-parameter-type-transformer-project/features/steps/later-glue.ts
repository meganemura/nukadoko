import { Given, defineParameterType } from "../../nukadoko-compat-shim.js";

// The object `defineParameterType`'s transformer was applied against.
// cucumber-js binds that `this` to the same World the step runs against
// (`arg.getValue(world)`), and awaits a Promise the transformer returns
// before the step is called. Both are asserted below: identity, and a
// resolved string rather than the Promise itself.
let transformerThis: unknown;

defineParameterType({
  name: "later",
  regexp: /soon|never/,
  // `this: any` matches CompatStepFn's own `this` (a World subclass is not
  // known here). A regular async function, not an arrow: an arrow would
  // ignore the World cucumber-expressions applies as `this`.
  transformer: async function (this: any, s: string) {
    transformerThis = this;
    await Promise.resolve();
    return s.toUpperCase();
  },
});

Given("it arrives {later}", function (this: any, word: unknown) {
  if (typeof word !== "string" || word !== "SOON") {
    throw new Error(`expected the string SOON, got ${typeof word} ${String(word)}`);
  }
  if (this == null || this !== transformerThis) {
    throw new Error("transformer this was not this step's World");
  }
});
