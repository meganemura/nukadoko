import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a step whose request never gets an answer ends through
// its own timeout under --concurrency as it does without it, and the run
// finishes. The server accepts each connection and never replies, so the
// timed-out request keeps its socket open in the process that made it.

const STEP = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the silent server is asked",
  description: "Ask a server that accepts the connection and never answers",
  args: z.object({}),
  returns: z.object({ status: z.number() }),
  mutates: false,
  timeout: 500,
  async run({ env }) {
    const response = await fetch(env.SILENT_URL ?? "");
    return { status: response.status };
  },
});
`;

const feature = (name: string): string => `Feature: ${name}\n\n  Scenario: asks ${name}\n    When the silent server is asked\n`;

async function withSilentServer<T>(body: (url: string) => Promise<T>): Promise<T> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    return await body(`http://127.0.0.1:${port}/`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("nuka run --concurrency: a request that never gets an answer", () => {
  for (const concurrency of ["1", "2"]) {
    it(`fails the step with its timeout and finishes the run, at --concurrency ${concurrency}`, () =>
      withSilentServer(async (url) => {
        const rootDir = await copyFixtureToTempDir("run-concurrency-project");
        try {
          await writeFile(path.join(rootDir, "features/steps/silent-server-asked.ts"), STEP);
          await mkdir(path.join(rootDir, "silent"));
          await writeFile(path.join(rootDir, "silent/a.feature"), feature("a"));
          await writeFile(path.join(rootDir, "silent/b.feature"), feature("b"));
          await writeFile(path.join(rootDir, ".env.silent"), `SILENT_URL=${url}\n`);
          await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'import { defineConfig } from "./nukadoko-shim.js";\nexport default defineConfig({ envFiles: [".env.silent"] });\n');

          const stderr = createCaptureSink();
          const exitCode = await runCli(["run", "silent", "--concurrency", concurrency], { rootDir, stdout: createCaptureSink(), stderr });

          expect(exitCode).toBe(1);
          expect(stderr.text()).not.toContain("run-incomplete");
          const scenarios = latestRunJson(rootDir).scenarios as { feature: string; steps: { status: string; error: { kind: string; message: string } | null }[] }[];
          const timedOut = { status: "failed", error: { kind: "timeout", message: 'Step "silent-server-asked" timed out after 500ms (the step\'s own timeout)' } };
          const outcomes = scenarios.map((scenario) => [scenario.feature, scenario.steps.map(({ status, error }) => ({ status, error }))] as const);
          expect([...outcomes].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
            ["silent/a.feature", [timedOut]],
            ["silent/b.feature", [timedOut]],
          ]);
        } finally {
          await removeTempDir(rootDir);
        }
      }), 30_000);
  }
});
