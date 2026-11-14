// Responsibility: before any test file runs, refresh the copies of the
// repository root's shared files (docs/, skills/, the READMEs, the
// changelog, llms.txt) that this package ships. Boundary: calls the same
// function the build calls, and nothing else. Several tests read those files
// through this package's root, as a reader of the installed package would,
// and `npx vitest run` alone does not build.
import { stageShared } from "../scripts/stage-shared.js";

export default function setup(): void {
  stageShared();
}
