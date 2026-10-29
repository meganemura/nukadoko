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
  // until the test says every opener has decided, so none of them meets a
  // holder that ended: on a loaded machine one can start seconds late, and
  // a holder gone by then is one it may take over.
  await writeFile(
    opener,
    [
      'import { existsSync } from "node:fs";',
      'import path from "node:path";',
      `import { openWalk } from ${JSON.stringify(walkFiles)};`,
      "const [project, at] = process.argv.slice(2);",
      "while (Date.now() < Number(at)) {}",
      'const walk = openWalk({ rootDir: project, stateDir: ".nukadoko", target: "features/a.feature:3" });',
      'process.stdout.write("refused" in walk ? "refused\\n" : `opened ${walk.number}\\n`);',
      'setInterval(() => { if (existsSync(path.join(project, "decided"))) process.exit(0); }, 20);',
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

interface Opener {
  /** What it printed once it decided. */
  readonly decided: Promise<string>;
  readonly closed: Promise<void>;
  readonly kill: () => void;
}

function open(project: string, at: number): Opener {
  const child = spawn(process.execPath, [...sourceNodeArgs, opener, project, String(at)], { stdio: ["ignore", "pipe", "inherit"] });
  let text = "";
  const decided = new Promise<string>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.endsWith("\n")) resolve(text);
    });
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return { decided, closed, kill: () => child.kill("SIGKILL") };
}

describe("the walk lock", () => {
  it(
    "lets exactly one of the runs that find a dead holder at the same moment take it over",
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const project = path.join(rootDir, `p${round}`);
        // A run that took the walk and was killed: its pid is dead, and
        // its lock is left as it was.
        const killed = open(project, 0);
        expect(await killed.decided).toBe("opened 1\n");
        killed.kill();
        await killed.closed;

        // Every process starts first and then waits for one moment, so
        // the takeovers overlap instead of following the spawn order.
        const at = Date.now() + 1000;
        const openers = Array.from({ length: PROCESSES }, () => open(project, at));
        const outputs = await Promise.all(openers.map((each) => each.decided));
        await writeFile(path.join(project, "decided"), "");
        await Promise.all(openers.map((each) => each.closed));
        const opened = outputs.filter((output) => output.startsWith("opened"));
        expect(opened, `round ${round}: ${outputs.join("")}`).toEqual(["opened 2\n"]);
        const walk = JSON.parse(await readFile(path.join(project, ".nukadoko", "walk.json"), "utf8")) as { number: number };
        expect(walk.number).toBe(2);
      }
    },
    120_000,
  );
});
