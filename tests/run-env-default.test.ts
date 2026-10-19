import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { resolveEnvironment } from "../src/environment/resolve-environment.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `--env default` names the environment a run without
// `--env` uses, the one run.json calls "default", whether or not the config
// defines `environments.default`: it combines with named environments in
// `nuka run`, works alone in `nuka do`, and resolves to the top-level
// settings unless the config defines its own entry.

describe("--env default", () => {
  let rootDir: string;

  beforeEach(async () => {
    // Defines staging and production, and no default.
    rootDir = await copyFixtureToTempDir("allure-identity-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("runs the implicit environment beside a named one in nuka run, under the name run.json gives it", async () => {
    const result = await cli(["run", "--json", "--env", "default", "--env", "staging"]);
    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout) as { environments: { name: string }[]; verdicts: { environment: string; verdict: string }[] };
    expect(document.environments.map((environment) => environment.name)).toEqual(["default", "staging"]);
    expect([...new Set(document.verdicts.map((cell) => `${cell.environment} ${cell.verdict}`))]).toEqual(["default passed", "staging passed"]);
  });

  it("runs a step under --env default in nuka do", async () => {
    const result = await cli(["do", "a-cart", "--args", '{"count":1}', "--env", "default"]);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as { environment: string }).environment).toBe("default");
  });

  it("resolves to the top-level settings, or to environments.default when the config defines it", () => {
    const base = { baseURL: "http://top.example", envFiles: [".env"] };
    expect(resolveEnvironment(base as never, "default", true)).toEqual({ name: "default", baseURL: "http://top.example", envFiles: [".env"], policy: undefined, version: undefined });
    const defined = { ...base, environments: { default: { baseURL: "http://own.example", envFiles: [".env.default"] } } };
    expect(resolveEnvironment(defined as never, "default", true)).toEqual({
      name: "default",
      baseURL: "http://own.example",
      envFiles: [".env", ".env.default"],
      policy: undefined,
      version: undefined,
    });
    expect(() => resolveEnvironment(base as never, "staging", true)).toThrow('Unknown environment "staging": not defined in nukadoko.config.ts\'s "environments"');
  });

  it("resolves --env default as leaving --env out does, for any config", () =>
    hegel.test((tc) => {
      const names = tc.draw(gs.arrays(gs.sampledFrom(["default", "staging", "production"] as const), { maxSize: 3 }));
      const environments = Object.fromEntries(names.map((name) => [name, { baseURL: `http://${name}.example`, envFiles: [`.env.${name}`] }]));
      const config = { baseURL: tc.draw(gs.sampledFrom([undefined, "http://top.example"])), envFiles: [".env"], environments } as never;
      expect(resolveEnvironment(config, "default", true)).toEqual(resolveEnvironment(config, "default", false));
    }));
});
