// Responsibility: one sentence for a step file that failed to import because
// it names a type that one of nukadoko's own entry points exports, in an
// import written without `type`. Node erases only `import type` and inline
// `type` names, so the plain import asks the module for a run-time export it
// does not have, and Node's own message says only that the export is
// missing. This module reads Node's message and appends nothing unless the
// name is in the table below; for any other module it cannot tell a type
// from a typo, so it stays silent.
//
// The table is a copy of what each entry point's declaration file exports as
// a type only. tests/type-only-export.test.ts reads the built declaration
// files and fails when the two differ, so a type added to an entry point
// cannot be missing here.

export const TYPE_ONLY_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  nukadoko: [
    "ActionEntry",
    "ArgOrigin",
    "CallEntry",
    "Claim",
    "ClaimCompare",
    "ClaimComparisonRecord",
    "ClaimEachRecord",
    "ClaimExpected",
    "ClaimItemRecord",
    "ClaimLiteral",
    "ClaimOutcome",
    "ClaimPoll",
    "ClaimRecord",
    "ClaimStep",
    "ClaimStepDefinition",
    "ClaimView",
    "ComparisonClaim",
    "ConsoleErrorEntry",
    "DeclaredLabel",
    "DeclaredLink",
    "DeclaredParameter",
    "DeclaredSnapshot",
    "DefaultReturns",
    "EachClaim",
    "EnvValue",
    "ErrorKind",
    "EvidenceAttachmentEntry",
    "EvidenceMeta",
    "FailedRequestEntry",
    "FileChange",
    "FixtureBag",
    "FixtureDefinition",
    "FixtureDeps",
    "FixtureFn",
    "FixtureOptions",
    "FixtureOutcome",
    "FixtureScope",
    "FixtureUsageEntry",
    "FromCandidate",
    "FromMap",
    "HttpOmittedCounts",
    "ItemClaim",
    "KeptText",
    "MeasuredChannel",
    "NamedTraceEntry",
    "NukadokoConfig",
    "NukadokoConfigInput",
    "ObserveInputs",
    "ObservedCounts",
    "PageErrorEntry",
    "PageEventsSnapshot",
    "PageEventsTruncated",
    "PollOptions",
    "PollRecord",
    "ProcessEntry",
    "ProcessEnv",
    "ProcessFiles",
    "ReplaceableFixtures",
    "RunCommandOptions",
    "RunCommandResult",
    "RunServerOptions",
    "RunStep",
    "RunStepDefinition",
    "RunningServer",
    "Scratch",
    "ScreenshotEntry",
    "SectionEntry",
    "Step",
    "StepBase",
    "StepDefinitionCommon",
    "StepDefinitionInput",
    "StepFixtures",
    "StepRecord",
    "StepRecordBase",
    "StepRecordFailed",
    "StepRecordPassed",
    "StepRunResult",
    "UnmeasuredEntry",
    "UseFn",
    "UsedEntry",
    "UsedEntryWithResult",
  ],
  "nukadoko/compat": [
    "AttachOptions",
    "HookFn",
    "HookOptions",
    "HookParameter",
    "ITestCaseHookParameter",
    "IWorldOptions",
    "InferWorldFields",
    "RunHookFn",
    "RunHookOptions",
    "WorldConstructor",
    "WorldConstructorParams",
  ],
  "nukadoko/matching": ["StaticPatternInput", "StaticPatternResolution"],
};

const MISSING_EXPORT = /The requested module '([^'\r\n]+)' does not provide an export named '([^'\r\n]+)'/;

export function typeOnlyImportSentence(message: string): string {
  const match = MISSING_EXPORT.exec(message);
  if (match === null) return "";
  const [, specifier, name] = match as unknown as [string, string, string];
  if (!(TYPE_ONLY_EXPORTS[specifier] ?? []).includes(name)) return "";
  return (
    `; ${name} is a type, which ${specifier} exports for TypeScript only, and Node erases an imported name only when the import marks it as a type. ` +
    `Write import type { ${name} } from "${specifier}", or mark the one name inline as { type ${name} }`
  );
}
