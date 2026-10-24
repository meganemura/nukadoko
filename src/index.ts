// Responsibility: the public "nukadoko" package entry point — the surface a
// step file, nukadoko.config.ts, or nukadoko.program.ts imports from. CLI
// wiring, discovery, and config loading are implementation details of this
// package's own `cli.ts`, not re-exported here.

export type { NukadokoConfig, NukadokoConfigInput } from "./config/schema.js";
export { defineConfig } from "./config/define-config.js";
export { defineProgram } from "./config/define-program.js";
export type { ProgramInput, ProgramWorld, ProgramWorldPlace } from "./config/program-schema.js";
export { ConfigError } from "./config/errors.js";
export type { FixtureBag, ReplaceableFixtures, Scratch, StepFixtures } from "./step/context.js";
export {
  ContextOptionsConflictError,
  InvalidContextNameError,
  InvalidScratchPrefixError,
  MissingEnvError,
} from "./context/errors.js";
export { defineFixtures } from "./fixture/define-fixtures.js";
export type {
  FixtureDefinition,
  FixtureDeps,
  FixtureFn,
  FixtureOptions,
  FixtureOutcome,
  UseFn,
} from "./step/fixture-types.js";
// `poll` itself is not exported: it moved onto `ctx.poll` — see
// src/step/context.ts's own header for why a runnable `poll`
// stayed importable for exactly as long as it recorded nothing.
export { InvalidPollOptionsError, PollTimeoutError } from "./context/poll.js";
export type { PollOptions } from "./step/context.js";
export type {
  ActionEntry,
  ArgOrigin,
  ConsoleErrorEntry,
  FailedRequestEntry,
  FileChange,
  FixtureScope,
  FixtureUsageEntry,
  HttpOmittedCounts,
  KeptText,
  ObservedCounts,
  PageErrorEntry,
  PageEventsSnapshot,
  PageEventsTruncated,
  ProgramLogSlice,
  UnmeasuredEntry,
  UsedEntry,
  UsedEntryWithResult,
} from "./record/types.js";
export { runCommand } from "./context/run-command.js";
export type { RunCommandOptions, RunCommandResult } from "./context/run-command.js";
export type { DeclaredLabel, DeclaredLink, DeclaredParameter, DeclaredSnapshot } from "./compat/declared.js";
export type {
  CallEntry,
  EnvValue,
  ErrorKind,
  EvidenceAttachmentEntry,
  EvidenceMeta,
  NamedTraceEntry,
  PollRecord,
  ProcessEntry,
  ProcessEnv,
  ProcessFiles,
  ScreenshotEntry,
  SectionEntry,
  StepRecord,
  StepRecordBase,
  StepRecordFailed,
  StepRecordPassed,
} from "./record/types.js";
export type {
  ClaimComparisonRecord,
  ClaimCompare,
  ClaimEachRecord,
  ClaimItemRecord,
  ClaimOutcome,
  ClaimRecord,
  ClaimView,
  MeasuredChannel,
} from "./record/types.js";
export type {
  ClaimStep,
  ClaimStepDefinition,
  DefaultReturns,
  FromCandidate,
  FromMap,
  ObserveInputs,
  RunStep,
  RunStepDefinition,
  Step,
  StepBase,
  StepDefinitionCommon,
  StepDefinitionInput,
  StepRunResult,
} from "./step/define-step.js";
export type { Claim, ClaimExpected, ClaimLiteral, ClaimPoll, ComparisonClaim, EachClaim, ItemClaim } from "./step/claims.js";
export { defineStep, InvalidStepDefinitionError } from "./step/define-step.js";
// `z` itself, not merely its type: `vocabulary.ts` calls
// `z.toJSONSchema(entry.step.args)` and `strict-args.ts` reads a schema's
// own `.type` property to decide whether to strictify it, both against
// this package's own zod install. A step file that imported a separate
// `zod` install would hand those two call sites an object neither one
// recognizes, so the same copy has to reach both sides. Re-exporting it
// also means a step file needs no dependency of its own to write
// `z.object(...)`: a package manager that does not hoist a dependency's
// own dependencies to a project's top level (unlike npm's default layout)
// would otherwise fail to resolve a bare `import { z } from "zod"` in a
// step file at all.
export { z } from "zod";
