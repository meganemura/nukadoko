import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyFixtureToTempDir, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: what a step prints (console.log, console.error, and a
// write to process.stdout) reaches stderr with the secrets a record
// redacts redacted, in `nuka run`, `nuka run --concurrency 2`, and
// `nuka do`. The CLI runs as its own process, because the step writes to
// the process streams, which an injected sink does not replace.

const API_TOKEN = "SECRETTOKEN123456";

const STEP = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the step prints the token",
  description: "Prints the loaded token on stdout and stderr",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ env }) {
    console.log(\`log Bearer \${env.API_TOKEN}\`);
    console.error(\`error Bearer \${env.API_TOKEN}\`);
    process.stdout.write(\`stdout Bearer \${env.API_TOKEN}\\n\`);
    return {};
  },
});
`;

const feature = (name: string): string => `Feature: print ${name}\n\n  Scenario: prints ${name}\n    When the step prints the token\n`;

function spawnedCli(rootDir: string, args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), ...args], { cwd: rootDir, timeout: 60_000 }, (error, _stdout, stderr) => {
      resolve({ exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stderr });
    });
  });
}

describe("a step's own output reaches stderr redacted", () => {
  const cases: readonly [string, readonly string[], number][] = [
    ["nuka run", ["run", "features/print-a.feature"], 1],
    ["nuka run --concurrency 2", ["run", "features/print-a.feature", "features/print-b.feature", "--concurrency", "2"], 2],
    ["nuka do", ["do", "prints-token", "--args", "{}"], 1],
  ];
  for (const [name, args, steps] of cases) {
    it(name, async () => {
      const rootDir = await copyFixtureToTempDir("stderr-redaction-project");
      try {
        await writeFile(path.join(rootDir, "features/steps/prints-token.ts"), STEP);
        await writeFile(path.join(rootDir, "features/print-a.feature"), feature("a"));
        await writeFile(path.join(rootDir, "features/print-b.feature"), feature("b"));

        const { exitCode, stderr } = await spawnedCli(rootDir, args);

        expect(exitCode).toBe(0);
        expect(stderr).not.toContain(API_TOKEN);
        for (const way of ["log", "error", "stdout"]) {
          expect(stderr.split("\n").filter((line) => line === `${way} Bearer {{secret.API_TOKEN}}`)).toHaveLength(steps);
        }
      } finally {
        await removeTempDir(rootDir);
      }
    }, 60_000);
  }
});
