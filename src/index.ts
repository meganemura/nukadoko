// Responsibility: the public "nukadoko" package entry point — the surface a
// step file or nukadoko.config.ts imports from. CLI wiring, discovery, and
// config loading are implementation details of this package's own `cli.ts`,
// not re-exported here.

export type { NukadokoConfig, NukadokoConfigInput } from "./config/schema.js";
export { defineConfig } from "./config/define-config.js";
export { ConfigError } from "./config/errors.js";
export type { StepFixtures } from "./context.js";
export { MissingEnvError } from "./context/errors.js";
export { defineFixtures } from "./fixture/define-fixtures.js";
export type {
  FixtureDefinition,
  FixtureDeps,
  FixtureFn,
  FixtureOptions,
  FixtureOutcome,
  FixtureScope,
  UseFn,
} from "./fixture/types.js";
// `poll` itself is not exported: it moved onto `ctx.poll` — see
// src/context.ts's own header for why a runnable `poll`
// stayed importable for exactly as long as it recorded nothing.
export { PollTimeoutError } from "./context/poll.js";
export type { PollOptions } from "./context/poll.js";
export type {
  ErrorKind,
  EvidenceMeta,
  Receipt,
  ReceiptFailed,
  ReceiptOk,
} from "./receipt/types.js";
export type { Step, StepDefinitionInput } from "./step/define-step.js";
export { defineStep } from "./step/define-step.js";
// EXPERIMENTAL: see call-tool.ts's own header for why the name carries the
// mark, and the condition that would let it be dropped.
export { experimental_callWebmcpTool } from "./webmcp/call-tool.js";
export type { WebmcpToolDescriptor } from "./webmcp/list-tools.js";
