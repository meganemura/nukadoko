import { readFileSync } from "node:fs";
import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

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

export default defineConfig({
  envFiles: [".env.secret"],
  environments: {
    default: {
      version: () => {
        throw new Error(`probe failed: Authorization: Bearer ${suiteToken()}`);
      },
    },
  },
  fixtures: defineFixtures({
    // Process scope: `nuka run` announces this teardown on stderr only. A
    // scenario-scope failure is copied onto the scenario record, which is
    // already redacted before that stderr line is printed.
    leakyTeardown: [
      async ({ env }: { env: Readonly<Record<string, string | undefined>> }, use) => {
        await use({ id: "t1" });
        throw new Error(`cleanup of tenant t1 failed: 401 for Bearer ${env.API_TOKEN}`);
      },
      { scope: "process" },
    ],
  }),
});
