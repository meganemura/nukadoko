import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { RefusalError, commandPathOf, refuse, verdictOf, withHint } from "../src/cli/refusal.js";
import { oneLine, parseFindings } from "../src/finding/finding.js";
import { listAllCheckCodes } from "../src/cli/check.js";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, withoutNoConfigLine } from "./helpers/fixtures.js";

describe("refuse", () => {
  it("prints one refused finding: an envelope on stdout under --json, the finding's lines on stderr otherwise", () =>
    hegel.test((tc) => {
      const message = tc.draw(gs.text({ alphabet: "ab :.-", maxSize: 60 }));
      const ownDo = tc.draw(gs.oneOf(gs.just(undefined), gs.text({ alphabet: "abz -", minSize: 1, maxSize: 30 })));
      const json = tc.draw(gs.booleans());
      const error = ownDo === undefined ? new Error(message) : new RefusalError("unknown-step", message, { do: ownDo });
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();

      const exitCode = refuse({ json, stdout, stderr, command: "check" }, error, "invalid-value");

      const expected =
        ownDo === undefined
          ? { severity: "refused", code: "invalid-value", message, fix: "Correct the flag's value as the message says.", do: "nuka check --help" }
          : { severity: "refused", code: "unknown-step", message, do: ownDo };
      expect(exitCode).toBe(2);
      if (json) {
        expect(stderr.text()).toBe("");
        const document = JSON.parse(stdout.text()) as Record<string, unknown>;
        expect(Object.keys(document)).toEqual(["schema_version", "nukadoko", "command", "verdict", "findings"]);
        expect(document).toMatchObject({ schema_version: 2, command: "check", verdict: "refused", findings: [expected] });
      } else {
        expect(stdout.text()).toBe("");
        const { severity, code, message: text, ...hints } = expected;
        expect(parseFindings(stderr.text())).toEqual([{ severity, code, where: "-", message: oneLine(text), ...hints }]);
      }
    }));

  it("reads a code and a hint from any error that carries them, and stringifies a value that is not an Error", () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const own = Object.assign(new Error("needs playwright"), {
      code: "playwright-missing",
      do: "npm install -D -E playwright@1.61.1",
    });
    const unregistered = Object.assign(new Error("no such file"), { code: "ENOENT" });

    refuse({ json: false, stdout, stderr, command: "run" }, own, "unexpected-error");
    refuse({ json: false, stdout, stderr, command: "run" }, 42, "unexpected-error");
    refuse({ json: false, stdout, stderr, command: "run" }, unregistered, "target-not-found");

    expect(stderr.text()).toBe(
      "refused\tplaywright-missing\t-\tneeds playwright\n  do: npm install -D -E playwright@1.61.1\n" +
        "refused\tunexpected-error\t-\t42\n  fix: Read the message; it is the error the command stopped on.\n  do: nuka run --help\n" +
        "refused\ttarget-not-found\t-\tno such file\n  fix: Name a file or a directory that exists.\n  do: nuka run --help\n",
    );
  });
});

describe("verdictOf", () => {
  it("maps 0 to passed, 2 to refused, and every other exit code to failed", () =>
    hegel.test((tc) => {
      const exitCode = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
      expect(verdictOf(exitCode)).toBe(exitCode === 0 ? "passed" : exitCode === 2 ? "refused" : "failed");
    }));
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

/** The findings of a refused envelope, without the config-missing warning a
 * fixture with no config file adds. */
function refusedFindings(stdout: string): Array<Record<string, unknown>> {
  const document = JSON.parse(stdout) as { verdict: string; findings: Array<Record<string, unknown>> };
  expect(document.verdict).toBe("refused");
  return document.findings.filter((finding) => finding.code !== "config-missing");
}

describe("a --json command that cannot report prints a refused envelope on stdout", () => {
  it.each([
    {
      argv: ["check", "--json", "nope.feature"],
      root: "basic-project",
      finding: { code: "target-not-found", message: "nuka check: feature file not found: nope.feature", fix: "Name a file or a directory that exists.", do: "nuka check --help" },
    },
    {
      argv: ["check", "--json", "features/inside.feature:3"],
      root: "check-feature-arg-project",
      finding: {
        code: "line-not-supported",
        message: "nuka check: features/inside.feature:3: :line is not supported; check analyzes the whole file, not one scenario",
        do: "nuka check features/inside.feature",
      },
    },
    {
      argv: ["steps", "--json"],
      root: "check-features-dir-missing-project",
      finding: {
        code: "features-dir-missing",
        message: `featuresDir "features" does not exist at ${fixture("check-features-dir-missing-project")}/features`,
        fix: "Create the featuresDir directory, or correct featuresDir in the config file.",
        do: "nuka steps --help",
      },
    },
    {
      argv: ["describe", "no-such-step"],
      root: "basic-project",
      finding: { code: "unknown-step", message: "Unknown step: no-such-step", do: "nuka steps" },
    },
    {
      argv: ["experimental", "explore", "models/a.ts", "--json", "--runs", "0"],
      root: "basic-project",
      finding: {
        code: "invalid-value",
        message: "--runs must be a whole number of 1 or more (got 0).",
        fix: "Correct the flag's value as the message says.",
        do: "nuka experimental explore --help",
      },
    },
    {
      argv: ["run", "--json", "nope.feature"],
      root: "basic-project",
      finding: { code: "target-not-found", message: "Feature file not found: nope.feature", fix: "Name a file or a directory that exists.", do: "nuka run --help" },
    },
    {
      argv: ["explore", "--json", "models/a.ts"],
      root: "basic-project",
      finding: { code: "removed-command", message: "`nuka explore` moved to `nuka experimental explore`", do: "nuka experimental explore --json models/a.ts" },
    },
    {
      argv: ["check", "--json", "--nope"],
      root: "basic-project",
      finding: {
        code: "invalid-arguments",
        message: "Unknown argument: nope",
        fix: "Correct the command line; the command's --help lists its flags.",
        do: "nuka check --help",
      },
    },
  ])("nuka $argv", async ({ argv, root, finding }) => {
    const result = await cli(argv, fixture(root));

    expect(result.stderr).toBe("");
    expect(refusedFindings(result.stdout)).toEqual([{ severity: "refused", ...finding }]);
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
    const [finding, ...rest] = refusedFindings(result.stdout);
    expect(rest).toEqual([]);
    expect(finding!.code).toBe("config-invalid");
    expect(finding!.message).toMatch(/^Invalid config at .*nukadoko\.config\.ts: /);
    expect(finding!.fix).toBe("Correct the fields the message names in nukadoko.config.ts.");
    expect(finding!.do).toBeUndefined();
    expect(result.exitCode).toBe(2);
  });

  it("nuka tend --json --fail-on bogus", async () => {
    const result = await cli(["tend", "--json", "--fail-on", "bogus"], fixture("basic-project"));

    expect(result.stderr).toBe("");
    expect(refusedFindings(result.stdout)).toEqual([
      { severity: "refused", code: "fail-on-unknown-code", message: '--fail-on: "bogus" is not a code nuka tend reports', do: "nuka tend --codes" },
    ]);
    expect(result.exitCode).toBe(2);
  });
});

describe("a refusal in text mode is a refused finding on stderr", () => {
  const ARGS = "  fix: Correct the command line; the command's --help lists its flags.\n";
  it.each([
    [["bogus"], `refused\tinvalid-arguments\t-\tUnknown argument: bogus\n${ARGS}  do: nuka --help\n`],
    [["check", "--nope"], `refused\tinvalid-arguments\t-\tUnknown argument: nope\n${ARGS}  do: nuka check --help\n`],
    [
      ["check", "nope.feature"],
      "refused\ttarget-not-found\t-\tnuka check: feature file not found: nope.feature\n  fix: Name a file or a directory that exists.\n  do: nuka check --help\n",
    ],
    [["do", "no-such-step", "--args", "{}"], "refused\tunknown-step\t-\tUnknown step: no-such-step\n  do: nuka steps\n"],
    [
      ["run", "--repeat", "0"],
      "refused\tinvalid-value\t-\t--repeat must be a whole number of 1 or more (got 0).\n  fix: Correct the flag's value as the message says.\n  do: nuka run --help\n",
    ],
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

    expect(
      result.stderr.endsWith(
        "refused\tcheck-errors\t-\tnuka run did not start: nuka check reports 1 error for these scenarios\n" +
          "  fix: Correct each error the findings name, or pass --no-check to run anyway.\n  do: nuka check features\n",
      ),
    ).toBe(true);
    expect(result.exitCode).toBe(2);
  });
});

describe("withHint", () => {
  const registered = listAllCheckCodes();

  it("keeps a finding's own hint, gives a registered code its registry fix otherwise, and is idempotent", () =>
    hegel.test((tc) => {
      const entry = tc.draw(gs.sampledFrom(registered));
      const code = tc.draw(gs.oneOf(gs.just(entry.code), gs.just("not-a-code")));
      const fix = tc.draw(gs.oneOf(gs.just(undefined), gs.text({ alphabet: "ab .", minSize: 1, maxSize: 20 })));
      const next = tc.draw(gs.oneOf(gs.just(undefined), gs.text({ alphabet: "ab -", minSize: 1, maxSize: 20 })));
      const finding = {
        severity: "warning" as const,
        code,
        message: "m",
        ...(fix !== undefined ? { fix } : {}),
        ...(next !== undefined ? { do: next } : {}),
      };

      const hinted = withHint(finding);

      if (fix !== undefined || next !== undefined) expect(hinted).toEqual(finding);
      else if (code === entry.code) expect(hinted).toEqual({ ...finding, fix: entry.fix });
      else expect(hinted).toEqual(finding);
      expect(withHint(hinted)).toEqual(hinted);
    }));
});
