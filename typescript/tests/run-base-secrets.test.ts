import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeBaseProject, type BaseProject, type TableRow } from "./helpers/base-project.js";
import { removeTempDir } from "./helpers/fixtures.js";

// Responsibility: that a tree of `nuka run --base` redacts what it writes
// with head's secret set (docs/spec.md "Environments and secrets"), so a
// ref whose config marks a value public cannot print head's secret in a
// record, run.json, the summary, or `--json`.

const SECRET = "tok-SECRET-9f3a7c";

let project: (BaseProject & { readonly top: string }) | undefined;

afterEach(async () => {
  if (project !== undefined) await removeTempDir(project.top);
  project = undefined;
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const config = (secrets: string): string => `import { defineConfig } from "nukadoko";\nexport default defineConfig({ envFiles: [".env"]${secrets} });\n`;

const SIGN_IN = (body: string): string => `import { z } from "zod";
import { defineStep } from "nukadoko";

export default defineStep({
  pattern: "the user signs in",
  description: "Signs in",
  args: z.object({}),
  returns: z.object({ outcome: z.string() }),
  mutates: false,
  async run({ env }) {
    ${body}
  },
});
`;

describe("the old world of a ref whose config marks head's secret public", () => {
  it("writes the secret nowhere, though the ref's step returns it and its claim breaks on it", async () => {
    project = await makeBaseProject();
    writeFileSync(path.join(project.top, ".gitignore"), ".nukadoko/\nnode_modules/\n.env\n");
    project.write({
      ".env": `API_TOKEN=${SECRET}\n`,
      "nukadoko.config.ts": config(`, secrets: { public: ["API_TOKEN"] }`),
      "features/steps/sign-in.ts": SIGN_IN(`return { outcome: env.API_TOKEN ?? "" };`),
      "features/steps/outcome-is.ts": `import { z } from "zod";
import { defineStep } from "nukadoko";
import signIn from "./sign-in.ts";

export default defineStep({
  pattern: "the sign-in is {expected:string}",
  description: "Checks the outcome",
  args: z.object({ expected: z.string(), outcome: z.string() }),
  from: { outcome: [signIn, "outcome"] },
  claims: [{ actual: "outcome", compare: "equal", expected: "expected" }],
});
`,
      "features/sign-in.feature": 'Feature: Sign in\n\n  Scenario: sign in\n    When the user signs in\n    Then the sign-in is "accepted"\n',
    });
    project.commit("base");
    project.write({ "nukadoko.config.ts": config(""), "features/steps/sign-in.ts": SIGN_IN(`void env;\n    return { outcome: "accepted" };`) });
    project.commit("head");
    const result = await project.cli(["run", "--json", "--base", "HEAD~1"]);
    const rows = (JSON.parse(result.stdout) as { table: { rows: TableRow[] } }).table.rows;
    // The old world ran the ref's step, which returned the secret.
    expect(rows.map((row) => [row.verdict, row.cells.map((cell) => `${cell.world}:${cell.outcome}`)])).toEqual([["moved", ["head:pass", "old:fail"]]]);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    const written = filesUnder(path.join(project.root, ".nukadoko")).filter((file) => readFileSync(file, "utf8").includes(SECRET));
    expect(written).toEqual([]);
  }, 60_000);
});
