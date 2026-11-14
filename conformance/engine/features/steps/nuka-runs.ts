import { defineStep, z } from "nukadoko";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { nuka, sameStepFiles } from "./lib/engine.ts";
import theProject from "./the-project.ts";
import theProjectInGit from "./the-project-in-a-git-repository.ts";

// Words split on spaces; a word in single quotes keeps its spaces.
function words(argv: string): string[] {
  return [...argv.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

type Finding = { severity: string; code: string; message?: string; fix?: string; do?: string };
type Envelope = { judged?: string; run_dir?: string; selection?: string; findings?: Finding[]; scenarios?: { feature: string; line: number; environment: string; status: string }[] };

// The newest record nuka do wrote in the project, for a `--use` that names it.
function lastStepRecord(dir: string): string {
  const records = path.join(dir, ".nukadoko", "do");
  const ids = readdirSync(records).sort((a, b) => statSync(path.join(records, a)).mtimeMs - statSync(path.join(records, b)).mtimeMs);
  const last = ids.at(-1);
  if (last === undefined) throw new Error("no nuka do record to use");
  return last;
}

// The findings nuka printed as text, for a command such as nuka do whose
// stdout is not an envelope: `severity<TAB>code<TAB>where<TAB>message`, then
// its `fix:` and `do:` lines.
function textFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    const last = findings.at(-1);
    if (fields.length >= 4) findings.push({ severity: fields[0]!, code: fields[1]!, message: fields.slice(3).join("\t") });
    else if (last !== undefined && line.startsWith("  fix: ")) last.fix = line.slice("  fix: ".length);
    else if (last !== undefined && line.startsWith("  do: ")) last.do = line.slice("  do: ".length);
  }
  return findings;
}

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
    argv: z.string().describe("Arguments after `nuka`, split on spaces; a word in single quotes keeps its spaces, and the word <last-step-record> is the id of the newest record nuka do wrote"),
    dir: theProject.returns.shape.dir,
  }),
  from: { dir: [[theProject, "dir"], [theProjectInGit, "dir"]] },
  returns: z.object({
    exitCode: z.number().nullable().describe("The process exit code"),
    stdout: z.string().describe("Everything nuka wrote to stdout"),
    stderr: z.string().describe("Everything nuka wrote to stderr"),
    scenarios: z.string().describe("Under --json, one line per scenario execution: feature:line environment status"),
    selection: z.string().describe("Under --json, the envelope's selection, or an empty string"),
    runDir: z.string().describe("Under --json, the envelope's run_dir, or an empty string"),
    codes: z.string().describe("Under --json, the code of every finding in order, separated by spaces"),
    judged: z.string().describe("Under --json, the envelope's judged, or an empty string"),
    stops: z.string().describe("Under --json, the codes of the refused and failed findings, separated by spaces"),
    printed: z.string().describe("stdout, then stderr, with each step file written as features/steps/<name>.*"),
    stop: z
      .string()
      .describe("The last refused or failed finding as lines of field: value (severity, code, message, fix, do), with the program file named nukadoko.program.*: the --json envelope's, or else the findings nuka printed on stderr"),
  }),
  // nuka writes its run directory inside the scratch project only.
  mutates: false,
  async run({}, { argv, dir }) {
    const ran = await nuka(dir, words(argv).map((word) => (word === "<last-step-record>" ? lastStepRecord(dir) : word)));
    const parsed = envelope(ran.stdout);
    parsed.findings ??= textFindings(ran.stderr);
    const scenarios = (parsed.scenarios ?? []).map((s) => `${s.feature}:${s.line} ${s.environment} ${s.status}`).join("\n");
    const stops = (parsed.findings ?? []).filter((f) => f.severity === "refused" || f.severity === "failed").map((f) => f.code).join(" ");
    // Each engine names its own program file; the rest of the text is the same.
    const last = (parsed.findings ?? []).filter((f) => f.severity === "refused" || f.severity === "failed").at(-1);
    const fields = ["severity", "code", "message", "fix", "do"] as const;
    const stop = last === undefined ? "" : fields.flatMap((key) => (last[key] === undefined ? [] : [`${key}: ${last[key]}`])).join("\n").replace(/nukadoko\.(program|config)\.(ts|rb)/g, "nukadoko.$1.*");
    // The project's own directory differs on each run.
    const own = (text: string): string => sameStepFiles(text).replaceAll(dir, "<project>");
    const printed = own(`${ran.stdout}${ran.stderr}`);
    return { stop: own(stop), printed, exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, scenarios, stops, selection: parsed.selection ?? "", runDir: parsed.run_dir ?? "", codes: (parsed.findings ?? []).map((f) => f.code).join(" "), judged: parsed.judged ?? "" };
  },
});
