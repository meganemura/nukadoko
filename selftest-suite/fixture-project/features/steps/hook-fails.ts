import { Before } from "nukadoko/compat";

// The only compat glue in this otherwise all-native fixture project --
// deliberately: partial migration (native steps and compat glue coexisting
// in one project) is the migration door principle itself, and a Before hook
// is not reachable any other way (`nukadoko`'s own top-level exports carry
// no Before/After; only `nukadoko/compat` does, since a native typed step
// has no hook registration of its own).
//
// Scoped to @hook-fails so it never touches mixed.feature's other two
// scenarios. Its only job is the selftest-allure task spec's decision 5, a
// known constraint pinned rather than hidden: a scenario a Before hook
// stops shows every one of its steps as "skipped" in the Allure report, not
// red, because step became the test-result unit and there is no longer a
// scenario-level test for the hook's own failure to turn red instead
// (docs/spec.md "Allure emitter"). `nuka run`'s own exit code and
// record.json are unaffected either way; only the report's own display is.
Before({ tags: "@hook-fails" }, function () {
  throw new Error("hook always fails, on purpose, to pin the skipped-not-red report limit");
});
