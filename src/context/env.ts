export { parseEnvFile } from "../env/parse-env-file.js";
export { EnvFileUnreadableError, loadEnvFiles } from "../env/load-env-files.js";

// Responsibility: the import path for `ctx.env`'s loader and the shared
// KEY=VALUE parser. The read itself lives in src/env/load-env-files.ts so
// the secret set can use the same loop without depending on this module:
// context already depends on secrets, and the reverse edge would only exist
// to reach this function. Callers that load `ctx.env` keep importing from
// here. The parser is re-exported for the same reason: a caller that
// already loads `ctx.env` can parse one file with the same function.
