import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --probe` through the CLI. A read-only Then that
// ignores its capture still passes with the capture changed and becomes a
// note; one that compares it fails the probe and stays quiet. Neither
// changes the exit code, and the probe leaves no step record.

const CHECKING_STEP = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import arrives from "./visitor-arrives.js";

export default defineStep({
  pattern: "the visitor {name:string} is recorded",
  description: "Compares the arrived visitor's name with the expected one",
  args: z.object({ name: z.string(), arrived: z.string() }),
  from: { arrived: [arrives, "name"] },
  returns: z.object({}),
  mutates: false,
  async run({}, args) {
    if (args.arrived !== args.name) throw new Error(\`expected \${args.name}, got \${args.arrived}\`);
    return {};
  },
});
`;

const CHECKING_FEATURE = `Feature: Recording a visitor

  Scenario: record a visitor
    Given a visitor named "Grace" arrives
    Then the visitor "Grace" is recorded
`;


const STORE_STEPS: Record<string, string> = {
  "file-holds.ts": `import { writeFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the file holds {content:string}",
  description: "Writes the content to the store file",
  args: z.object({ content: z.string() }),
  returns: z.object({}),
  mutates: true,
  async run({}, args) {
    writeFileSync(new URL("../../store.txt", import.meta.url), args.content);
    return {};
  },
});
`,
  "file-set.ts": `import { writeFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the file is set to {content:string}",
  description: "Replaces the store file's content",
  args: z.object({ content: z.string() }),
  returns: z.object({}),
  mutates: true,
  async run({}, args) {
    writeFileSync(new URL("../../store.txt", import.meta.url), args.content);
    return {};
  },
});
`,
  "file-reads.ts": `import { readFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the file reads {content:string}",
  description: "Compares the store file's content with the expected one",
  args: z.object({ content: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run({}, args) {
    const content = readFileSync(new URL("../../store.txt", import.meta.url), "utf8");
    if (content !== args.content) throw new Error(\`expected \${args.content}, got \${content}\`);
    return {};
  },
});
`,
  "color-is.ts": `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the color is {color:string}",
  description: "Accepts one of two colors",
  args: z.object({ color: z.enum(["red", "blue"]) }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
`,
  "shell-answers.ts": `import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the shell answers {answer:string}",
  description: "Runs a process and ignores what it printed",
  args: z.object({ answer: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    await runCommand(process.execPath, ["-e", ""]);
    return {};
  },
});
`,
  "shell-only-when-changed.ts": `import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the shell is quiet for {answer:string}",
  description: "Runs a process only for an answer other than ok",
  args: z.object({ answer: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run({}, args) {
    if (args.answer !== "ok") await runCommand(process.execPath, ["-e", ""]);
    return {};
  },
});
`,
};

const STORE_FEATURE = `Feature: A store file

  Scenario: read live state
    Given the file holds "a"
    Then the file reads "a"
    When the file is set to "a-probe"
    Then the file reads "a-probe"
`;

const UNMEASURED_FEATURE = `Feature: Unmeasured probes

  Scenario: a schema and a process
    Then the color is "red"
    And the shell answers "ok"
`;

interface Document {
  verdict: string;
  findings: { severity: string; code: string; message: string }[];
  scenarios: { feature: string; steps: { step_record_id: string | null }[]; probes?: unknown[] }[];
}

describe("nuka run --probe", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(path.join(rootDir, "features", "steps", "visitor-recorded.ts"), CHECKING_STEP);
    await writeFile(path.join(rootDir, "features", "recorded.feature"), CHECKING_FEATURE);
    for (const [name, source] of Object.entries(STORE_STEPS)) await writeFile(path.join(rootDir, "features", "steps", name), source);
    await writeFile(path.join(rootDir, "features", "store.feature"), STORE_FEATURE);
    await writeFile(path.join(rootDir, "features", "unmeasured.feature"), UNMEASURED_FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function run(args: string[]): Promise<{ exitCode: number; document: Document; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--json", ...args], { rootDir, stdout, stderr });
    return { exitCode, document: JSON.parse(stdout.text()) as Document, stderr: stderr.text() };
  }

  it("notes a Then that passes with its capture changed, and stays green", async () => {
    const { exitCode, document } = await run(["--probe", "features/greeting.feature"]);
    expect(exitCode).toBe(0);
    expect(document.verdict).toBe("passed");
    expect(document.scenarios[0]!.probes).toEqual([
      { line: 5, step: "visitor-greeted", text: 'the visitor "Ada" is greeted', key: "name", recorded: "Ada", changed: "Ada-probe", status: "passed" },
    ]);
    expect(document.findings).toEqual([
      {
        severity: "note",
        code: "then-passed-with-changed-capture",
        file: "features/greeting.feature",
        line: 5,
        step: "visitor-greeted",
        message: 'the visitor "Ada" is greeted: step "visitor-greeted" passed with name "Ada-probe" in place of "Ada"',
        fix: 'Make the step compare its result with the capture the message names; a step whose sentence also allows the changed value, such as "at least n", can stay as it is.',
        do: "nuka run features/greeting.feature:3 --probe",
      },
    ]);
  });

  it("records a probe the Then caught, with no note and no step record", async () => {
    const { exitCode, document } = await run(["--probe", "features/recorded.feature"]);
    expect(exitCode).toBe(0);
    expect(document.findings).toEqual([]);
    const [scenario] = document.scenarios;
    expect(scenario!.probes).toEqual([
      { line: 5, step: "visitor-recorded", text: 'the visitor "Grace" is recorded', key: "name", recorded: "Grace", changed: "Grace-probe", status: "caught" },
    ]);
    expect(scenario!.steps.map((step) => step.step_record_id === null)).toEqual([false, false]);
  });

  it("probes nothing without the flag", async () => {
    const { document } = await run(["features/greeting.feature"]);
    expect(document.findings).toEqual([]);
    expect(document.scenarios[0]!.probes).toBeUndefined();
  });

  it("probes in every worker under --concurrency", async () => {
    const { exitCode, document } = await run(["--probe", "--concurrency", "2", "features/greeting.feature", "features/recorded.feature"]);
    expect(exitCode).toBe(0);
    const probes = Object.fromEntries(document.scenarios.map((scenario) => [scenario.feature, scenario.probes]));
    expect(probes).toEqual({
      "features/greeting.feature": [
        { line: 5, step: "visitor-greeted", text: 'the visitor "Ada" is greeted', key: "name", recorded: "Ada", changed: "Ada-probe", status: "passed" },
      ],
      "features/recorded.feature": [
        { line: 5, step: "visitor-recorded", text: 'the visitor "Grace" is recorded', key: "name", recorded: "Grace", changed: "Grace-probe", status: "caught" },
      ],
    });
    expect(document.findings.map((finding) => finding.code)).toEqual(["then-passed-with-changed-capture"]);
  });

  it("prints the note after the count line in text", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--probe", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toContain(
      'note\tthen-passed-with-changed-capture\tfeatures/greeting.feature:5\tthe visitor "Ada" is greeted: step "visitor-greeted" passed with name "Ada-probe" in place of "Ada"\n',
    );
  });
  it("probes a Then against the state it read, before a later When changes it", async () => {
    const { exitCode, document } = await run(["--probe", "features/store.feature"]);
    expect(exitCode).toBe(0);
    expect(document.findings).toEqual([]);
    expect(document.scenarios[0]!.probes).toEqual([
      { line: 5, step: "file-reads", text: 'the file reads "a"', key: "content", recorded: "a", changed: "a-probe", status: "caught" },
      { line: 7, step: "file-reads", text: 'the file reads "a-probe"', key: "content", recorded: "a-probe", changed: "a-probe-probe", status: "caught" },
    ]);
  });

  it("notes a probe that an args schema refused, and one of a step that ran a process", async () => {
    const { exitCode, document } = await run(["--probe", "features/unmeasured.feature"]);
    expect(exitCode).toBe(0);
    expect(document.scenarios[0]!.probes).toEqual([
      {
        line: 4,
        step: "color-is",
        text: 'the color is "red"',
        key: "color",
        recorded: "red",
        changed: "red-probe",
        status: "not-measured",
        reason: "args-rejected",
        message: 'color: Invalid option: expected one of "red"|"blue"',
      },
      {
        line: 5,
        step: "shell-answers",
        text: 'the shell answers "ok"',
        key: "answer",
        recorded: "ok",
        changed: "ok-probe",
        status: "not-measured",
        reason: "wrote",
        message: "the step ran 1 process when it ran, so it is not run again",
      },
    ]);
    expect(document.findings.map((finding) => [finding.code, finding.message])).toEqual([
      ["then-probe-not-measured", 'the color is "red": step "color-is" was not probed with color "red-probe" (args-rejected): color: Invalid option: expected one of "red"|"blue"'],
      [
        "then-probe-not-measured",
        'the shell answers "ok": step "shell-answers" was not probed with answer "ok-probe" (wrote): the step ran 1 process when it ran, so it is not run again',
      ],
    ]);
  });

  it("does not count a probe whose own re-run ran a process, and says the re-run wrote", async () => {
    await writeFile(path.join(rootDir, "features", "quiet.feature"), 'Feature: A quiet shell\n\n  Scenario: quiet\n    Then the shell is quiet for "ok"\n');
    const { exitCode, document } = await run(["--probe", "features/quiet.feature"]);
    expect(exitCode).toBe(0);
    expect(document.scenarios[0]!.probes).toEqual([
      {
        line: 4,
        step: "shell-only-when-changed",
        text: 'the shell is quiet for "ok"',
        key: "answer",
        recorded: "ok",
        changed: "ok-probe",
        status: "not-measured",
        reason: "wrote",
        message: "the probe's own re-run ran 1 process, so its outcome is not used",
      },
    ]);
    expect(document.findings.map((finding) => [finding.code, finding.message])).toEqual([
      [
        "then-probe-not-measured",
        'the shell is quiet for "ok": step "shell-only-when-changed" was not probed with answer "ok-probe" (wrote): the probe\'s own re-run ran 1 process, so its outcome is not used',
      ],
    ]);
  });

  it("probes a Then whose expected value is only a docstring or a table", async () => {
    await writeFile(
      path.join(rootDir, "features", "steps", "output-is.ts"),
      `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the output is",
  description: "Reads the output and never compares it with the docstring",
  args: z.object({ expected: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
`,
    );
    await writeFile(
      path.join(rootDir, "features", "steps", "rows-are.ts"),
      `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the rows are",
  description: "Compares the rows with the table",
  args: z.object({ rows: z.array(z.array(z.string())) }),
  returns: z.object({}),
  mutates: false,
  async run({}, args) {
    if (JSON.stringify(args.rows) !== JSON.stringify([["name"], ["Ada"]])) throw new Error("rows differ");
    return {};
  },
});
`,
    );
    await writeFile(
      path.join(rootDir, "features", "attached.feature"),
      `Feature: Attached values

  Scenario: a docstring and a table
    Then the output is
      """
      hello
      """
    And the rows are
      | name |
      | Ada  |
`,
    );
    const { exitCode, document } = await run(["--probe", "features/attached.feature"]);
    expect(exitCode).toBe(0);
    expect(document.scenarios[0]!.probes).toEqual([
      { line: 4, step: "output-is", text: "the output is", key: "expected", recorded: "hello", changed: "hello-probe", status: "passed" },
      { line: 8, step: "rows-are", text: "the rows are", key: "rows[1][0]", recorded: "Ada", changed: "Ada-probe", status: "caught" },
    ]);
    expect(document.findings.map((finding) => [finding.code, finding.message])).toEqual([
      ["then-passed-with-changed-capture", 'the output is: step "output-is" passed with expected "hello-probe" in place of "hello"'],
    ]);
  });

  it("folds the notes of --repeat into one per step and key", async () => {
    const { document } = await run(["--probe", "--repeat", "3", "features/greeting.feature"]);
    expect(document.findings.map((finding) => [finding.code, finding.message])).toEqual([
      ["then-passed-with-changed-capture", 'the visitor "Ada" is greeted: step "visitor-greeted" passed with name "Ada-probe" in place of "Ada"'],
    ]);
  });
});
