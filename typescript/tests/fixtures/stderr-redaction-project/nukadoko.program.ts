import { readFileSync } from "node:fs";
import { defineProgram } from "./nukadoko-shim.js";

// The same untracked file `envFiles` loads. A version probe is user code, so
// its thrown message can carry a value from that file (a request error that
// prints an Authorization header). Reading it here puts that value in the
// probe failure the executor writes to stderr.
function suiteToken(): string {
  const text = readFileSync(new URL("./.env.secret", import.meta.url), "utf8");
  const line = text.split("\n").find((entry) => entry.startsWith("API_TOKEN="));
  if (line === undefined) {
    throw new Error("fixture env file has no API_TOKEN");
  }
  return line.slice("API_TOKEN=".length).trim();
}

export default defineProgram({
  environments: {
    default: {
      version: () => {
        throw new Error(`probe failed: Authorization: Bearer ${suiteToken()}`);
      },
    },
  },
});
