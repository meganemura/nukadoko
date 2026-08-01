// Responsibility: the public "nukadoko" package entry point — the surface a
// step file or nukadoko.config.ts imports from. CLI wiring, discovery, and
// config loading are implementation details of this package's own `cli.ts`,
// not re-exported here.

export type { NukadokoConfig, NukadokoConfigInput } from "./config/schema.js";
export { defineConfig } from "./config/define-config.js";
export { ConfigError } from "./config/errors.js";
export type { PollOptions, StepContext } from "./context.js";
export type { EvidenceMeta, Receipt, ReceiptFailed, ReceiptOk } from "./receipt/types.js";
export type { Step, StepDefinitionInput } from "./step/define-step.js";
export { defineStep } from "./step/define-step.js";
