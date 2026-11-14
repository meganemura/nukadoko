import { defineStep, z } from "nukadoko";
import { nuka } from "./lib/engine.ts";
import theProject from "./the-project.ts";

// Words split on spaces; a word in single quotes keeps its spaces.
function words(argv: string): string[] {
  return [...argv.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

type Envelope = { selection?: string; findings?: { severity: string; code: string }[]; scenarios?: { feature: string; line: number; environment: string; status: string }[] };

function envelope(stdout: string): Envelope {
  try {
    return JSON.parse(stdout) as Envelope;
  } catch {
    return {};
  }
}

export default defineStep({
  description: "Run this world's engine's nuka with these arguments in the project an earlier step built",
  pattern: "nuka runs {argv:string}",
  args: z.object({
    argv: z.string().describe("Arguments after `nuka`, split on spaces; a word in single quotes keeps its spaces"),
    dir: theProject.returns.shape.dir,
  }),
  from: { dir: [theProject, "dir"] },
  returns: z.object({
    exitCode: z.number().nullable().describe("The process exit code"),
    stdout: z.string().describe("Everything nuka wrote to stdout"),
    stderr: z.string().describe("Everything nuka wrote to stderr"),
    scenarios: z.string().describe("Under --json, one line per scenario execution: feature:line environment status"),
    selection: z.string().describe("Under --json, the envelope's selection, or an empty string"),
    stops: z.string().describe("Under --json, the codes of the refused and failed findings, separated by spaces"),
  }),
  // nuka writes its run directory inside the scratch project only.
  mutates: false,
  async run({}, { argv, dir }) {
    const ran = await nuka(dir, words(argv));
    const parsed = envelope(ran.stdout);
    const scenarios = (parsed.scenarios ?? []).map((s) => `${s.feature}:${s.line} ${s.environment} ${s.status}`).join("\n");
    const stops = (parsed.findings ?? []).filter((f) => f.severity === "refused" || f.severity === "failed").map((f) => f.code).join(" ");
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, scenarios, stops, selection: parsed.selection ?? "" };
  },
});
