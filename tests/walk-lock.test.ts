import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// The walk lock is shared by processes, so it is tested with processes: a
// run that was killed leaves its lock behind, and the runs after it race to
// take it over at the same moment.

const PROCESSES = 6;
const ROUNDS = 4;

let rootDir: string;
let opener: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "nukadoko-walk-lock-"));
  opener = path.join(rootDir, "open.mjs");
  const walkFiles = pathToFileURL(path.join(repoRoot, "src", "run", "walk-files.ts")).href;
  // Every opener waits for the same moment, takes the walk, and stays alive
  // long enough that each of the others meets it as a live holder.
  await writeFile(
    opener,
    [
      `import { openWalk } from ${JSON.stringify(walkFiles)};`,
      "const [project, at, hold] = process.argv.slice(2);",
      "while (Date.now() < Number(at)) {}",
      'const walk = openWalk({ rootDir: project, stateDir: ".nukadoko", target: "features/a.feature:3" });',
      'process.stdout.write("refused" in walk ? "refused\\n" : `opened ${walk.number}\\n`);',
      "setTimeout(() => {}, Number(hold));",
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function open(project: string, at: number, holdMs: number): Promise<string> {
  const child = spawn(process.execPath, [...sourceNodeArgs, opener, project, String(at), String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return new Promise<string>((resolve) => child.once("close", () => resolve(text)));
}

async function untilPrinted(output: () => string): Promise<void> {
  while (output() === "") await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the walk lock", () => {
  it(
    "lets exactly one of the runs that find a dead holder at the same moment take it over",
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const project = path.join(rootDir, `p${round}`);
        // A run that took the walk and was killed: its pid is dead, and
        // its lock is left as it was.
        let killedText = "";
        const killed = spawn(process.execPath, [...sourceNodeArgs, opener, project, "0", "600000"], { stdio: ["ignore", "pipe", "inherit"] });
        killed.stdout.on("data", (chunk: Buffer) => {
          killedText += chunk.toString("utf8");
        });
        await untilPrinted(() => killedText);
        expect(killedText).toBe("opened 1\n");
        const gone = new Promise((resolve) => killed.once("close", resolve));
        killed.kill("SIGKILL");
        await gone;

        // Every process starts first and then waits for one moment, so
        // the takeovers overlap instead of following the spawn order.
        const at = Date.now() + 1000;
        const outputs = await Promise.all(Array.from({ length: PROCESSES }, () => open(project, at, 1200)));
        const opened = outputs.filter((output) => output.startsWith("opened"));
        expect(opened, `round ${round}: ${outputs.join("")}`).toEqual(["opened 2\n"]);
        const walk = JSON.parse(await readFile(path.join(project, ".nukadoko", "walk.json"), "utf8")) as { number: number };
        expect(walk.number).toBe(2);
      }
    },
    120_000,
  );
});
