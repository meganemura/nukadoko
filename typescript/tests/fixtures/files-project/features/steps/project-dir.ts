import { fileURLToPath } from "node:url";

// The project directory, whatever directory the run itself started in: a
// test runs nukadoko in-process from the repository root, and a command
// that wrote there would change the repository.
export const projectDir = fileURLToPath(new URL("../..", import.meta.url));
