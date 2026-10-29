import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layerProgram, programSchema, type ProgramInput } from "../src/config/program-schema.js";
import { groupAlive, parseProcStat } from "../src/process-group/process-group.js";
import { createWorldStarter } from "../src/program/world.js";
import { createCaptureSink, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: stopping a world's process group gives the whole group
// its grace period after SIGTERM (src/program/world.ts,
// src/process-group/process-group.ts): a server a shell started still writes its
// last lines after the shell exits, for `serve` and for a `build` or
// `prepare` command stopped at its limit, and the stop ends as soon as the
// group is gone, not after the whole grace period.

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("parseProcStat", () => {
  it("reads the state and the process group after any executable name", () =>
    hegel.test((tc) => {
      const comm = tc.draw(gs.text({ maxSize: 16 }));
      const state = tc.draw(gs.sampledFrom(["R", "S", "D", "Z", "T", "t", "X", "I"]));
      const pid = tc.draw(gs.integers({ minValue: 1, maxValue: 4_194_304 }));
      const ppid = tc.draw(gs.integers({ minValue: 0, maxValue: 4_194_304 }));
      const pgrp = tc.draw(gs.integers({ minValue: 0, maxValue: 4_194_304 }));
      expect(parseProcStat(`${pid} (${comm}) ${state} ${ppid} ${pgrp} ${pgrp} 0 -1 4194560 120 0 0 0\n`)).toEqual({ state, pgrp });
    }));

  it("answers undefined for text that is not a stat line", () => {
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("12 nocomm S 1 12")).toBeUndefined();
    expect(parseProcStat("12 (a) S 1")).toBeUndefined();
  });
});

describe.runIf(process.platform !== "win32")("a stopped process group", () => {
  let rootDir: string;
  let runDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), "nukadoko-group-"));
    runDir = path.join(rootDir, ".nukadoko", "runs", "r1");
    // A server that, on SIGTERM, takes 300 ms to write its last line, as
    // a program that flushes its buffered output on the way out does.
    writeFileSync(
      path.join(rootDir, "server.mjs"),
      [
        'import { createServer } from "node:http";',
        'process.on("SIGTERM", () => setTimeout(() => { console.log("flushed on SIGTERM"); process.exit(0); }, 300));',
        'if (process.env.PORT) createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT));',
        "else setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function starter() {
    return createWorldStarter({
      rootDir,
      worldDir: (name) => path.join(runDir, "worlds", name),
      recordPath: (absolutePath) => path.relative(runDir, absolutePath),
      displayPath: (absolutePath) => path.relative(rootDir, absolutePath),
      progress: createCaptureSink(),
    });
  }

  function recipe(input: ProgramInput) {
    return layerProgram(programSchema.parse(input), undefined);
  }

  it("answers false once every member exited, a member no parent reaped included", async () => {
    const leader = spawn("sh", ["-c", "sleep 0.3 & exit 0"], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => leader.once("exit", resolve));
    expect(groupAlive(leader.pid!)).toBe(true);
    await delay(800);
    expect(groupAlive(leader.pid!)).toBe(false);
  });

  it("lets a server a shell started write its last line when the world stops", async () => {
    const world = await starter().start(
      "default",
      recipe({ serve: { command: ["sh", "-c", "node server.mjs; echo leader done"], ready: "/" }, env: { PORT: "{port}" } }),
      [],
    );
    if (!world.ok) throw new Error(world.message);
    const begun = Date.now();
    await world.stop();
    expect(Date.now() - begun).toBeLessThan(3_000);
    expect(readFileSync(path.join(runDir, "worlds", "default", "program.log"), "utf8")).toContain("flushed on SIGTERM\n");
  });

  it("keeps nukadoko's process alive while the group gets its grace period, so a stop that nothing else waits on still ends", async () => {
    // In a process of its own, where nothing but the stop keeps the event
    // loop alive: the server ends 120 ms after SIGTERM, inside a wait
    // between two probes of the group, and the stop has to finish and
    // print, not leave its top-level await unsettled (exit 13).
    writeFileSync(
      path.join(rootDir, "late-exit.mjs"),
      [
        'import { createServer } from "node:http";',
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 120));',
        'createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT));',
        "",
      ].join("\n"),
    );
    const script = path.join(rootDir, "stop-world.ts");
    writeFileSync(
      script,
      [
        `import { layerProgram, programSchema } from ${JSON.stringify(path.join(repoRoot, "src", "config", "program-schema.ts"))};`,
        `import { createWorldStarter } from ${JSON.stringify(path.join(repoRoot, "src", "program", "world.ts"))};`,
        `const rootDir = ${JSON.stringify(rootDir)};`,
        "const sink = { write: () => true };",
        'const starter = createWorldStarter({ rootDir, worldDir: (name) => `${rootDir}/w/${name}`, recordPath: (p) => p, displayPath: (p) => p, progress: sink });',
        'const world = await starter.start("default", layerProgram(programSchema.parse({ serve: { command: "node late-exit.mjs" }, env: { PORT: "{port}" } }), undefined), []);',
        'if (!world.ok) throw new Error(world.message);',
        "await world.stop();",
        'console.log("stopped");',
        "",
      ].join("\n"),
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [...sourceNodeArgs, script], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect({ code: result.code, stdout: result.stdout }, result.stderr).toEqual({ code: 0, stdout: "stopped\n" });
  });

  it("lets a prepare command's group write its last line when the command is stopped at its limit", async () => {
    const begun = Date.now();
    const world = await starter().start("default", recipe({ prepare: [{ command: ["sh", "-c", "node server.mjs"], timeout_ms: 300 }] }), []);
    expect(world.ok ? null : world.message).toMatch(/prepare command sh -c 'node server\.mjs' did not finish within 300 ms \(timeout_ms\)/);
    expect(Date.now() - begun).toBeLessThan(3_000);
    expect(readFileSync(path.join(runDir, "worlds", "default", "program.log"), "utf8")).toContain("flushed on SIGTERM\n");
  });
});
