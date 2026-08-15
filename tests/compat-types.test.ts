import { describe, expectTypeOf, it } from "vitest";
import type {
  HookParameter,
  ITestCaseHookParameter,
  IWorldOptions,
  WorldConstructorParams,
} from "../src/compat/index.js";

// Responsibility: type-only regression coverage — the compat surface
// (src/compat/index.ts) didn't export
// `IWorldOptions`/`ITestCaseHookParameter` even though both appear in 2/2
// real-world repos each (m2.1-a compat-audit synthesis), so glue written
// exactly the way cucumber-js's own docs show it (`import { type
// IWorldOptions } from "nukadoko/compat"`) failed `tsc` while `nuka
// run`/`nuka check` stayed silent (esbuild strips a type-only import).
// Nothing here has a runtime effect — `IWorldOptions`/`ITestCaseHookParameter`
// are aliases, erased at compile time — so the only thing a test can do is
// put each name somewhere `tsc` actually checks; a broken export shows up as
// `npm run typecheck` failing on this file, not as a failing assertion here.
// Imported via this file's own relative path to src/compat/index.ts, not the
// bare "nukadoko/compat" specifier, for the same reason the fixtures under
// tests/fixtures/*/nukadoko-shim.ts give: that specifier only resolves
// through a package.json this repo's own root doesn't have reason to carry.
describe("compat/index.ts type exports (m2.1-a compat-audit: IWorldOptions/ITestCaseHookParameter, 2/2 repos each)", () => {
  it("re-exports IWorldOptions as cucumber-js's own name for WorldConstructorParams", () => {
    const useIWorldOptions = (options: IWorldOptions) => options.parameters;
    expectTypeOf(useIWorldOptions).parameter(0).toEqualTypeOf<WorldConstructorParams>();
  });

  it("re-exports ITestCaseHookParameter as cucumber-js's own name for HookParameter", () => {
    const useITestCaseHookParameter = (param: ITestCaseHookParameter) => param.pickle;
    expectTypeOf(useITestCaseHookParameter).parameter(0).toEqualTypeOf<HookParameter>();
  });

  // WorldConstructorParams was already exported from compat/index.ts before
  // this task; HookParameter (hooks.ts's own type) was not, even though
  // HookFn/HookOptions (its neighbors) were — this brings it in line.
  it("also exports HookParameter itself, not just its ITestCaseHookParameter alias", () => {
    const useHookParameter = (param: HookParameter) => param.testCaseStartedId;
    expectTypeOf(useHookParameter).parameter(0).toEqualTypeOf<HookParameter>();
  });
});
