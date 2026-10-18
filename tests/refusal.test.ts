import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { RefusalError, commandPathOf, refuse } from "../src/cli/refusal.js";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, withoutNoConfigLine } from "./helpers/fixtures.js";

describe("refuse", () => {
  it("writes one JSON object with error and do on stdout under --json, and the message plus a do: line otherwise", () =>
    hegel.test((tc) => {
      const message = tc.draw(gs.text({ maxSize: 60 }));
      const ownDo = tc.draw(gs.oneOf(gs.just(undefined), gs.just(""), gs.text({ minSize: 1, maxSize: 30 })));
      const json = tc.draw(gs.booleans());
      const error = ownDo === undefined ? new Error(message) : new RefusalError(message, ownDo);
      const expectedDo = ownDo === undefined || ownDo === "" ? "nuka check --help" : ownDo;
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();

      const exitCode = refuse({ json, stdout, stderr }, error, "nuka check --help");

      expect(exitCode).toBe(2);
      if (json) {
        expect(stderr.text()).toBe("");
        expect(stdout.text().endsWith("\n")).toBe(true);
        expect(stdout.text().slice(0, -1).includes("\n")).toBe(false);
        expect(stdout.text().startsWith('{"schema_version":1,')).toBe(true);
        expect(JSON.parse(stdout.text())).toEqual({ schema_version: 1, error: message, do: expectedDo });
      } else {
        expect(stdout.text()).toBe("");
        expect(stderr.text()).toBe(`${message}\ndo: ${expectedDo}\n`);
      }
    }));

  it("reads a do from any error that carries one, and stringifies a value that is not an Error", () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const own = Object.assign(new Error("needs playwright"), { do: "npm install -D -E playwright@1.61.1" });

    refuse({ json: false, stdout, stderr }, own, "nuka run --help");
    refuse({ json: false, stdout, stderr }, 42, "nuka run --help");

    expect(stderr.text()).toBe(
      "needs playwright\ndo: npm install -D -E playwright@1.61.1\n42\ndo: nuka run --help\n",
    );
  });
});

describe("commandPathOf", () => {
  const commands = new Map<string, readonly string[]>([
    ["check", []],
    ["session", ["list", "start"]],
  ]);

  it("names the command and subcommand an argv starts with, skipping flags", () => {
    expect(commandPathOf(["session", "--env", "staging"], commands)).toBe("session");
    expect(commandPathOf(["--json", "session", "start", "s1"], commands)).toBe("session start");
    expect(commandPathOf(["check", "features/a.feature"], commands)).toBe("check");
    expect(commandPathOf(["bogus"], commands)).toBe("");
    expect(commandPathOf([], commands)).toBe("");
  });

  it("never names a command the table does not hold", () =>
    hegel.test((tc) => {
      const argv = tc.draw(
        gs.arrays(gs.oneOf(gs.sampledFrom(["check", "session", "list", "start", "--json", "-x"]), gs.text({ maxSize: 8 })), {
          maxSize: 5,
        }),
      );
      const [top, sub] = commandPathOf(argv, commands).split(" ");
      if (top === "") return;
      expect(commands.has(top!)).toBe(true);
      if (sub !== undefined) expect(commands.get(top!)).toContain(sub);
    }));
});

async function cli(argv: string[], rootDir: string) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: withoutNoConfigLine(stderr.text()) };
}

describe("a --json command that cannot report prints { error, do } on stdout", () => {
  it.each([
    {
      argv: ["check", "--json", "nope.feature"],
      root: "basic-project",
      error: "nuka check: feature file not found: nope.feature",
      do: "nuka check --help",
    },
    {
      argv: ["check", "--json", "features/inside.feature:3"],
      root: "check-feature-arg-project",
      error:
        "nuka check: features/inside.feature:3: :line is not supported; check analyzes the whole file, not one scenario. Run: nuka check features/inside.feature",
      do: "nuka check features/inside.feature",
    },
    {
      argv: ["steps", "--json"],
      root: "check-features-dir-missing-project",
      error: `featuresDir "features" does not exist at ${fixture("check-features-dir-missing-project")}/features`,
      do: "nuka steps --help",
    },
    {
      argv: ["describe", "no-such-step"],
      root: "basic-project",
      error: "Unknown step: no-such-step",
      do: "nuka steps",
    },
    {
      argv: ["experimental", "explore", "models/a.ts", "--json", "--runs", "0"],
      root: "basic-project",
      error: "--runs must be a whole number of 1 or more (got 0).",
      do: "nuka experimental explore --help",
    },
    {
      argv: ["run", "--json", "nope.feature"],
      root: "basic-project",
      error: "Feature file not found: nope.feature",
      do: "nuka run --help",
    },
    {
      argv: ["explore", "--json", "models/a.ts"],
      root: "basic-project",
      error: "`nuka explore` moved to `nuka experimental explore`; run that instead, with the same arguments",
      do: "nuka experimental explore --json models/a.ts",
    },
    {
      argv: ["check", "--json", "--nope"],
      root: "basic-project",
      error: "Unknown argument: nope",
      do: "nuka check --help",
    },
  ])("nuka $argv", async ({ argv, root, error, do: next }) => {
    const result = await cli(argv, fixture(root));

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, error, do: next });
    expect(result.exitCode).toBe(2);
  });

  it.each([
    ["check", "--json"],
    ["tend", "--json"],
    ["clean", "--json", "--dry-run"],
    ["session", "list", "--json"],
  ])("nuka %s %s on an invalid config", async (...argv) => {
    const result = await cli(argv, fixture("invalid-config-project"));

    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as { error: string; do: string };
    expect(report.error).toMatch(/^Invalid config at .*nukadoko\.config\.ts: /);
    expect(report.do).toBe("Correct the fields the message names in nukadoko.config.ts.");
    expect(result.exitCode).toBe(2);
  });

  it("nuka tend --json --fail-on bogus", async () => {
    const result = await cli(["tend", "--json", "--fail-on", "bogus"], fixture("basic-project"));

    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as { error: string; do: string };
    expect(report.error).toBe('--fail-on: "bogus" is not a code nuka tend reports. `nuka tend --codes` lists every code.');
    expect(report.do).toBe("nuka tend --codes");
    expect(result.exitCode).toBe(2);
  });
});

describe("a refusal in text mode ends with a do: line", () => {
  it.each([
    [["bogus"], "Unknown argument: bogus\ndo: nuka --help\n"],
    [["check", "--nope"], "Unknown argument: nope\ndo: nuka check --help\n"],
    [["check", "nope.feature"], "nuka check: feature file not found: nope.feature\ndo: nuka check --help\n"],
    [["do", "no-such-step", "--args", "{}"], "Unknown step: no-such-step\ndo: nuka steps\n"],
    [["run", "--repeat", "0"], "--repeat must be a whole number of 1 or more (got 0).\ndo: nuka run --help\n"],
  ])("nuka %j", async (argv, expected) => {
    const result = await cli(argv, fixture("basic-project"));

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(expected);
    expect(result.exitCode).toBe(2);
  });
});

describe("the exit code tells a red report from a refusal", () => {
  it.each([
    { argv: ["check"], root: "check-clean-project", exitCode: 0 },
    { argv: ["check"], root: "check-errors-project", exitCode: 1 },
    { argv: ["check", "nope.feature"], root: "check-clean-project", exitCode: 2 },
    { argv: ["run"], root: "check-unbuilt-pattern-project", exitCode: 2 },
    { argv: ["check", "--bogus"], root: "check-clean-project", exitCode: 2 },
  ])("nuka $argv in $root exits $exitCode", async ({ argv, root, exitCode }) => {
    const result = await cli(argv, fixture(root));

    expect(result.exitCode).toBe(exitCode);
  });

  it("names the check command on the run it stopped", async () => {
    const result = await cli(["run", "features"], fixture("check-unbuilt-pattern-project"));

    expect(result.stderr.endsWith("Fix them, or pass --no-check to run anyway.\ndo: nuka check features\n")).toBe(true);
    expect(result.exitCode).toBe(2);
  });
});
