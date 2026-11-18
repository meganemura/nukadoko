import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engine } from "./lib/engine.ts";
import theHelpIsRead from "./the-help-of-every-command-is-read.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type Table = { commands: Record<string, Record<"ruby" | "typescript", string[] | null>> };

export default defineStep({
  description: "docs/engines.json gives this world's engine the commands and flags its help named",
  pattern: "docs\\/engines.json lists the same commands and flags for this engine",
  args: z.object({ listed: theHelpIsRead.returns.shape.listed }),
  from: { listed: [theHelpIsRead, "listed"] },
  observe() {
    const table = JSON.parse(readFileSync(path.join(root, "docs", "engines.json"), "utf8")) as Table;
    const lines = Object.entries(table.commands)
      .filter(([, engines]) => engines[engine()] !== null)
      .map(([command, engines]) => [command, ...[...engines[engine()]!].sort()].join(" "))
      .sort();
    return { declared: lines.join("\n") };
  },
  claims: [{ actual: "declared", compare: "equal", expected: { from: "listed" } }],
});
