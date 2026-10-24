import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Before, getRegisteredHooks } from "../src/compat/hooks.js";
import { drainCompatSteps, getDefaultTimeoutMs, Given, setDefaultTimeout } from "../src/compat/registry.js";
import { BeforeAll, getRegisteredRunHooks } from "../src/compat/run-hooks.js";
import { programSchema } from "../src/config/program-schema.js";
import { configSchema } from "../src/config/schema.js";
import { runCommand } from "../src/context/run-command.js";
import { MAX_TIMER_DELAY_MS } from "../src/timer/max-delay.js";

// Responsibility: every limit nukadoko arms from a value a project writes
// refuses one that no Node.js timer keeps (src/timer/max-delay.ts), where
// the project writes it, instead of firing after 1 ms and failing a phase or
// a step for a limit it never waited for.

const TOO_LONG = MAX_TIMER_DELAY_MS + 1;
const LIMIT_TEXT = "at most 2147483647 ms, the longest delay a Node.js timer keeps (a longer one fires after 1 ms)";


describe("nukadoko.program.ts", () => {
  const withTimeout = (timeout: number) => [
    { where: "build.0.timeout_ms", input: { build: [{ command: "make", timeout_ms: timeout }] } },
    { where: "prepare.0.timeout_ms", input: { prepare: [{ command: "seed", timeout_ms: timeout }] } },
    { where: "serve.timeout_ms", input: { serve: { command: "node app.js", timeout_ms: timeout } } },
    { where: "setup.timeout_ms", input: { setup: { run: () => undefined, timeout_ms: timeout } } },
    { where: "url.timeout_ms", input: { url: { resolve: () => "http://a.example", timeout_ms: timeout } } },
  ];

  it("accepts every timeout_ms from 1 ms to the longest delay a timer keeps, and refuses each one past it by that limit", () =>
    hegel.test((tc) => {
      const kept = tc.draw(gs.integers({ minValue: 1, maxValue: MAX_TIMER_DELAY_MS }));
      const past = tc.draw(gs.integers({ minValue: TOO_LONG, maxValue: Number.MAX_SAFE_INTEGER }));
      for (const { input } of withTimeout(kept)) expect(programSchema.safeParse(input).success).toBe(true);
      for (const { where, input } of withTimeout(past)) {
        const result = programSchema.safeParse(input);
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([`${where}: must be ${LIMIT_TEXT}`]);
      }
    }));
});

describe("nukadoko.config.ts", () => {
  it("refuses a stepTimeout, a fixtureTimeout, or a fixture's own timeout past the longest delay a timer keeps", () => {
    const messages = (input: unknown): string[] => {
      const result = configSchema.safeParse(input);
      return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    };
    expect(messages({ stepTimeout: TOO_LONG })).toEqual([`stepTimeout: must be ${LIMIT_TEXT}`]);
    expect(messages({ fixtureTimeout: TOO_LONG })).toEqual([`fixtureTimeout: must be ${LIMIT_TEXT}`]);
    expect(messages({ fixtures: { seeded: [async () => undefined, { timeout: TOO_LONG }] } })).toEqual([
      `fixtures.seeded: fixture options.timeout must be a positive number of milliseconds, ${LIMIT_TEXT}`,
    ]);
    expect(messages({ stepTimeout: MAX_TIMER_DELAY_MS, fixtureTimeout: MAX_TIMER_DELAY_MS })).toEqual([]);
  });
});

describe("runCommand", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("refuses a timeout past the longest delay a timer keeps before the program starts", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "nukadoko-timer-"));
    const marker = path.join(dir, "ran");
    await expect(runCommand(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], { timeout: TOO_LONG })).rejects.toThrow(
      `runCommand: timeout is ${TOO_LONG} ms; it must be ${LIMIT_TEXT}`,
    );
    expect(existsSync(marker)).toBe(false);
    await runCommand(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], { timeout: MAX_TIMER_DELAY_MS });
    expect(existsSync(marker)).toBe(true);
  });
});

describe("compat timeouts", () => {
  it("refuse at registration a timeout past the longest delay a timer keeps, and keep -1 as no limit", () => {
    expect(() => setDefaultTimeout(TOO_LONG)).toThrow(`setDefaultTimeout(${TOO_LONG}): the timeout is ${TOO_LONG} ms; it must be ${LIMIT_TEXT}, or -1 for no limit`);
    expect(getDefaultTimeoutMs()).toBeUndefined();
    expect(() => Given("a step", { timeout: TOO_LONG }, () => undefined)).toThrow(`Given(a step, { timeout }, fn): the timeout is ${TOO_LONG} ms`);
    expect(() => Before({ timeout: TOO_LONG }, () => undefined)).toThrow(`Before({ timeout }, fn): the timeout is ${TOO_LONG} ms`);
    expect(() => BeforeAll({ timeout: TOO_LONG }, () => undefined)).toThrow(`BeforeAll({ timeout }, fn): the timeout is ${TOO_LONG} ms`);
    expect(drainCompatSteps()).toEqual([]);
    expect(getRegisteredHooks()).toEqual([]);
    expect(getRegisteredRunHooks()).toEqual([]);

    setDefaultTimeout(-1);
    Given("a step", { timeout: MAX_TIMER_DELAY_MS }, () => undefined);
    Before({ timeout: -1 }, () => undefined);
    expect(getDefaultTimeoutMs()).toBe(-1);
    expect(drainCompatSteps().map((step) => step.timeoutMs)).toEqual([MAX_TIMER_DELAY_MS]);
    expect(getRegisteredHooks().map((hook) => hook.timeoutMs)).toEqual([-1]);
  });
});
