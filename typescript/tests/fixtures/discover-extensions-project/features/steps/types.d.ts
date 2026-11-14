// Exists only to prove discovery's walk excludes .d.ts (a type declaration,
// never a step definition) -- see tests/discover-steps.test.ts's own
// "excludes .d.ts/.d.mts" case. Declarations only: a .d.ts file may not
// carry executable statements, so unlike the node_modules/dot-directory
// fixtures beside this one, this file cannot throw if ever imported; the
// test instead asserts directly against discoverSteps' own walkedFiles.
export declare const shouldNeverBeStepDefault: string;
