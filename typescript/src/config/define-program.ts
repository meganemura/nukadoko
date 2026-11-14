import type { ProgramInput } from "./program-schema.js";

// Responsibility: the `defineProgram` identity helper, which gives
// nukadoko.program.ts's object literal a type and nothing else, the same
// convention `defineConfig` follows. Validation needs the file's path for
// its message, so it happens where the file is loaded
// (src/config/load-program.ts).
export function defineProgram(program: ProgramInput): ProgramInput {
  return program;
}
