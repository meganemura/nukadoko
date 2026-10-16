import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { locateConfig, noConfigLine } from "../src/config/config-presence.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// A command run where no config file exists says so on stderr, and names a
// config found in a parent directory. Only `scaffold` changes its exit code,
// and only in the parent case.

const STEP = `import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Do nothing",
  pattern: "nothing happens",
  args: z.object({}),
  mutates: false,
  async run() {},
});
`;

async function writeProject(dir: string): Promise<void> {
  await mkdir(path.join(dir, "features", "steps"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(path.join(dir, "features", "steps", "nothing.ts"), STEP);
  await writeFile(path.join(dir, "features", "a.feature"), "Feature: a\n\n  Scenario: s\n    Then nothing happens\n");
}

async function nuka(rootDir: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const code = await runCli(argv, { rootDir, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function missingLine(dir: string): string {
  return `no nukadoko.config.ts or nukadoko.config.mts in ${dir}; nukadoko's defaults apply (featuresDir "features")`;
}

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

beforeAll(async () => {
  await ensureNukadokoShim();
});

describe("a command run in a directory with no config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createEmptyTempDir();
    await writeProject(dir);
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const commands: Array<{ argv: string[]; code: number }> = [
    { argv: ["check"], code: 0 },
    { argv: ["check", "--json"], code: 0 },
    { argv: ["steps"], code: 0 },
    { argv: ["steps", "--json"], code: 0 },
    { argv: ["tend"], code: 0 },
  ];

  for (const { argv, code } of commands) {
    it(`nuka ${argv.join(" ")} prints the line once on stderr and keeps its stdout and exit code`, async () => {
      const without = await nuka(dir, argv);
      await writeFile(path.join(dir, "nukadoko.config.ts"), "export default {};\n");
      const withConfig = await nuka(dir, argv);

      expect(without.code).toBe(code);
      expect(withConfig.code).toBe(code);
      expect(occurrences(without.stderr, `${missingLine(dir)}\n`)).toBe(1);
      expect(withConfig.stderr).not.toContain("no nukadoko.config.ts");
      expect(without.stdout).toBe(withConfig.stdout);
    });
  }

  it("nuka run prints the line once and still runs the scenario", async () => {
    const result = await nuka(dir, ["run"]);
    expect(result.code).toBe(0);
    expect(occurrences(result.stderr, `${missingLine(dir)}\n`)).toBe(1);
  });

  it("nuka scaffold prints the line and writes the step file", async () => {
    const result = await nuka(dir, ["scaffold", "stray", "--pattern", "something stray"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${path.join("features", "steps", "stray.ts")}\n`);
    expect(occurrences(result.stderr, `${missingLine(dir)}\n`)).toBe(1);
  });

  it("a failed parse prints only its own error", async () => {
    const unknown = await nuka(dir, ["check", "--nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("Unknown argument: nope\n");
    const repeated = await nuka(dir, ["run", "features/a.feature", "--env", "a", "--env", "b"]);
    expect(repeated.code).toBe(1);
    expect(repeated.stderr).toBe("--env was given more than once.\n");
  });
});

describe("a command run below a directory that has a config", () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    root = await createEmptyTempDir();
    await writeProject(root);
    await writeFile(path.join(root, "nukadoko.config.ts"), "export default {};\n");
    cwd = path.join(root, "packages", "app");
    await writeProject(cwd);
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("names the parent config relative to the cwd", async () => {
    const result = await nuka(cwd, ["check"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      `${missingLine(cwd)}; one exists at ../../nukadoko.config.ts: run nuka from that directory\n`,
    );
  });

  it("nuka scaffold refuses and writes nothing", async () => {
    const result = await nuka(cwd, ["scaffold", "stray", "--pattern", "something stray"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `Refusing to scaffold: no nukadoko.config.ts or nukadoko.config.mts in ${cwd}, and one exists at ../../nukadoko.config.ts; ` +
        "a step file written here is not one that config reads. Run nuka scaffold from that directory\n",
    );
    expect(existsSync(path.join(cwd, "features", "steps", "stray.ts"))).toBe(false);
  });

  it("nuka scaffold --feature refuses the same way", async () => {
    await writeFile(path.join(cwd, "features", "b.feature"), "Feature: b\n\n  Scenario: s\n    When something new happens\n");
    const result = await nuka(cwd, ["scaffold", "--feature", "features/b.feature"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `Refusing to scaffold: no nukadoko.config.ts or nukadoko.config.mts in ${cwd}, and one exists at ../../nukadoko.config.ts; ` +
        "a step file written here is not one that config reads. Run nuka scaffold from that directory\n",
    );
    expect(existsSync(path.join(cwd, "features", "steps", "something-new-happens.ts"))).toBe(false);
  });

  it("prints nothing once the cwd has its own config", async () => {
    await writeFile(path.join(cwd, "nukadoko.config.ts"), "export default {};\n");
    const result = await nuka(cwd, ["check"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("locateConfig over an ancestor chain", () => {
  it("reports here, the nearest parent config up to the .git directory, or absent", () =>
    hegel.test((tc) => {
      const depth = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
      const dirs = Array.from({ length: depth + 1 }, (_, i) =>
        path.join(path.sep, "w", ...Array.from({ length: i }, (_, j) => `d${j}`)),
      );
      const gitAt = tc.draw(gs.integers({ minValue: 0, maxValue: depth }));
      const configs = new Map<number, string>();
      for (const index of tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: depth }), { maxSize: 3 }))) {
        configs.set(index, tc.draw(gs.sampledFrom(["nukadoko.config.ts", "nukadoko.config.mts"])));
      }
      const files = new Set([path.join(dirs[gitAt]!, ".git")]);
      for (const [index, fileName] of configs) files.add(path.join(dirs[index]!, fileName));

      const cwd = dirs[depth]!;
      const presence = locateConfig(cwd, (filePath) => files.has(filePath));
      const line = noConfigLine(cwd, presence);

      const nearest = [...configs.keys()].filter((index) => index < depth && index >= gitAt).sort((a, b) => b - a)[0];
      if (configs.has(depth)) {
        expect(presence).toEqual({ kind: "here" });
        expect(line).toBeNull();
      } else if (nearest === undefined) {
        expect(presence).toEqual({ kind: "absent" });
        expect(line).toBe(missingLine(cwd));
      } else {
        const configPath = path.join(dirs[nearest]!, configs.get(nearest)!);
        expect(presence).toEqual({ kind: "parent", configPath });
        expect(line).toBe(
          `${missingLine(cwd)}; one exists at ${"../".repeat(depth - nearest)}${configs.get(nearest)}: run nuka from that directory`,
        );
      }
    }));
});
