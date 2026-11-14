import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCli } from "../../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim } from "./fixtures.js";

// Responsibility: the small git project the `nuka run --base` tests build
// a history in: a program module (`lib/cart.mjs`) outside the features
// directory, a step that prices a cart with it, and a claim step on the
// total, all importing nukadoko by its package name through the test shim
// (tests/helpers/fixtures.ts), so a tree's copy of a step loads as a
// project's would.

export const CART_STEP = `import { z } from "zod";
import { defineStep } from "nukadoko";
import { total } from "../../lib/cart.mjs";

export default defineStep({
  pattern: "a cart with {count:int} items",
  description: "Prices a cart of the given number of items",
  args: z.object({ count: z.number().int() }),
  returns: z.object({ total: z.number().int() }),
  mutates: false,
  async run({}, { count }) {
    return { total: total(count) };
  },
});
`;

/** The claim step on the total, comparing with `compare`. */
export const totalStep = (compare: string, cartStep = "./a-cart.ts"): string => `import { z } from "zod";
import { defineStep } from "nukadoko";
import aCart from ${JSON.stringify(cartStep)};

export default defineStep({
  pattern: "the total is {expected:int}",
  description: "Checks the cart's total",
  args: z.object({ expected: z.number().int(), total: z.number().int() }),
  from: { total: [aCart, "total"] },
  claims: [{ actual: "total", compare: ${JSON.stringify(compare)}, expected: "expected" }],
});
`;

export const scenario = (name: string, count: number, total: number, tags = ""): string =>
  `${tags === "" ? "" : `  ${tags}\n`}  Scenario: ${name}\n    Given a cart with ${count} items\n    Then the total is ${total}\n`;

export const feature = (...scenarios: string[]): string => `Feature: Cart\n\n${scenarios.join("\n")}`;

export const cartModule = (body = "return count * 2;"): string => `export function total(count) {\n  ${body}\n}\n`;

export interface BaseProject {
  readonly root: string;
  /** Writes each file, relative to the project root. */
  write(files: Readonly<Record<string, string>>): void;
  git(...args: string[]): string;
  /** Commits everything under `message`. */
  commit(message: string): string;
  cli(args: readonly string[], at?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** A project with a config, `lib/cart.mjs`, the two steps, and git
 * initialized but nothing committed. `dir` puts it in a subdirectory of
 * the temporary directory, which is then the repository's top. */
export async function makeBaseProject(options: { readonly dir?: string } = {}): Promise<BaseProject & { readonly top: string }> {
  await ensureNukadokoShim();
  const top = await createEmptyTempDir();
  const root = options.dir === undefined ? top : path.join(top, options.dir);
  const write = (files: Readonly<Record<string, string>>): void => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
  };
  write({
    "package.json": `${JSON.stringify({ name: "cart", private: true, type: "module" })}\n`,
    "nukadoko.config.ts": `import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n`,
    "lib/cart.mjs": cartModule(),
    "features/steps/a-cart.ts": CART_STEP,
    "features/steps/total-is.ts": totalStep("equal"),
  });
  writeFileSync(path.join(top, ".gitignore"), ".nukadoko/\nnode_modules/\n");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", top, "-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "protocol.file.allow=always", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  return {
    root,
    top,
    write,
    git,
    commit(message) {
      git("add", "-A");
      git("commit", "-qm", message);
      return git("rev-parse", "HEAD");
    },
    async cli(args, at = root) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli([...args], { rootDir: at, stdout, stderr });
      return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
    },
  };
}

/** One row of run.json's table, as the tests read it. */
export interface TableRow {
  feature: string;
  line: number;
  name: string;
  change: string | null;
  renamed_from?: { feature: string; name: string };
  retagged?: boolean;
  verdict: string;
  reason: string;
  cells: { world: string; environment: string; role: string; outcome: string; line?: number; runs: number; reason?: string; conditions: Record<string, unknown> }[];
}

/** Each row as `[name, change, verdict, cells]`, the cells as
 * `world:environment:outcome`. */
export function rowSummary(rows: readonly TableRow[]): [string, string | null, string, string[]][] {
  return rows.map((row) => [row.name, row.change, row.verdict, row.cells.map((cell) => `${cell.world}:${cell.environment}:${cell.outcome}`)]);
}
