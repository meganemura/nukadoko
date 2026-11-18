// Responsibility: print what ruby/bin/sync-codes writes into the gem's
// code registry: every code `nuka check --codes --json` lists, in its order
// and words, and which registry it comes from (`check`, `run`, or
// `refusal`). Boundary: reads the built registries in dist/ and writes
// JSON to stdout; nothing else.
//
// The source is the one fact `--codes` does not print and the gem needs:
// `nuka check --fail-on` accepts only a check code, and a run code can
// carry a warning or a note severity too, so the severity cannot tell them
// apart. Run directly by Node after `npm run build`.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { isCheckCode } = (await import(path.join(root, "dist", "check", "codes.js"))) as { isCheckCode: (code: string) => boolean };
const { listRunCodes } = (await import(path.join(root, "dist", "finding", "run-codes.js"))) as {
  listRunCodes: () => ReadonlyArray<{ code: string }>;
};
const run = new Set(listRunCodes().map((entry) => entry.code));
const listed = JSON.parse(
  execFileSync(process.execPath, [path.join(root, "dist", "cli.js"), "check", "--codes", "--json"], { cwd: root, encoding: "utf8" }),
) as { codes: Array<{ code: string; severity: string; message: string; fix: string }> };
const codes = listed.codes.map((entry) => ({
  ...entry,
  source: isCheckCode(entry.code) ? "check" : run.has(entry.code) ? "run" : "refusal",
}));
process.stdout.write(`${JSON.stringify({ codes }, null, 2)}\n`);
