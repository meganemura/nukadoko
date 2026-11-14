import { writeFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { checkCommandFor } from "../src/cli/run.js";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the `do:` line of `nuka run`'s check-errors refusal is a
// `nuka check` invocation that check accepts as printed. check reads whole
// files and refuses a `:line` target, so the line names each targeted file
// once, without its line, and keeps the `--env` flags.

const BAD_FEATURE = ["Feature: Bad", "", "  Scenario: one", "    Given nothing matches this line", "", "  Scenario: two", "    Given nothing matches this line", ""].join("\n");

async function cli(rootDir: string, argv: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([...argv], { rootDir, stdout, stderr });
  return { exitCode, stderr: stderr.text() };
}

describe("nuka run: the check-errors do: line runs as printed", () => {
  it("names each file once, without :line, and nuka check runs it", async () => {
    const rootDir = await copyFixtureToTempDir("run-verdict-hooks-project");
    try {
      writeFileSync(path.join(rootDir, "features", "bad.feature"), BAD_FEATURE);
      const ran = await cli(rootDir, ["run", "features/bad.feature:3", "features/bad.feature:6", "features/value.feature:3", "--env", "flag-on"]);
      expect(ran.exitCode).toBe(2);
      const doLine = ran.stderr.split("\n").find((line) => line.startsWith("  do: nuka check"));
      expect(doLine).toBe("  do: nuka check features/bad.feature features/value.feature --env flag-on");

      const check = await cli(rootDir, doLine!.slice("  do: nuka ".length).split(" "));
      expect(check.exitCode).toBe(1);
      expect(check.stderr).not.toContain("refused");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("never passes a :line target, and keeps every file and --env flag in order", () =>
    hegel.test((tc) => {
      const file = gs.sampledFrom(["a.feature", "features/b.feature", "features/sub/c.feature", "features"]);
      const target = gs.tuples(file, gs.oneOf(gs.just(null), gs.integers({ minValue: 1, maxValue: 400 }))).map(([name, line]) => (line === null ? name : `${name}:${line}`));
      const targets = tc.draw(gs.arrays(target, { maxSize: 6 }));
      const envs = tc.draw(gs.arrays(gs.sampledFrom(["staging", "flag-on", "flag-off"]), { maxSize: 3 }));

      const words = checkCommandFor(targets, envs).split(" ");
      expect(words.slice(0, 2)).toEqual(["nuka", "check"]);
      const firstEnv = words.indexOf("--env");
      const named = words.slice(2, firstEnv === -1 ? undefined : firstEnv);
      expect(named.filter((word) => /:\d+$/.test(word))).toEqual([]);
      expect(named).toEqual([...new Set(targets.map((entry) => entry.replace(/:\d+$/, "")))]);
      expect(firstEnv === -1 ? [] : words.slice(firstEnv)).toEqual(envs.flatMap((name) => ["--env", name]));
    }));
});
