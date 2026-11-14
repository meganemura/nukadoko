// Runs the scenarios under conformance/engine/features with the TypeScript
// engine. Each scenario runs once in the world `typescript` and once in the
// world `ruby`, and drives that engine's own `nuka` in a project of its own,
// so a behavior those scenarios describe holds only when both engines show it.
// Arguments go to `nuka run` as they are (`--env typescript`, a feature file).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const project = path.join(here, "engine");
const engine = path.join(root, "typescript");
const link = path.join(project, "node_modules", "nukadoko");
if (!existsSync(link)) {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(engine, link, "dir");
}
const result = spawnSync(process.execPath, [path.join(engine, "dist", "cli.js"), "run", ...process.argv.slice(2)], { cwd: project, stdio: "inherit" });
process.exit(result.status ?? 1);
