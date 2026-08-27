// Responsibility: the one public surface src/extension.ts imports index
// logic through -- re-exports only, mirroring src/extraction/index.ts's own
// barrel so both pure layers this package has are reached the same way.
export { buildStepIndex, type FileSource } from "./build-index.js";
export { parseStepLine } from "./step-line.js";
export { buildCompletionCandidates, type CompletionCandidate } from "./completion-candidates.js";
