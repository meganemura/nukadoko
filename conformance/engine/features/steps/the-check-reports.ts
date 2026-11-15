import { defineStep, z } from "nukadoko";
import path from "node:path";
import { sameStepFiles } from "./lib/engine.ts";
import nukaRuns from "./nuka-runs.ts";

type Finding = { severity: string; code: string; file?: string; line?: number; message: string };

export default defineStep({
  description:
    "The --json envelope's findings, one line each as severity, code, where, and message, sorted, are exactly the docstring; a step file is written as features/steps/<name>.* with no line, the config and program files as nukadoko.config.* and nukadoko.program.*, and a step file's definition, which the TypeScript engine names as defineStep and the Ruby engine by the step's class, as <step>",
  pattern: "the check reports",
  args: z.object({
    expected: z.string().describe("One finding per line, sorted"),
    stdout: nukaRuns.returns.shape.stdout,
  }),
  from: { stdout: [nukaRuns, "stdout"] },
  // Each engine's step file has its own extension and its own line, and the
  // order findings come in is not part of what a finding says.
  observe({}, { stdout }) {
    const findings = (JSON.parse(stdout) as { findings: Finding[] }).findings;
    const lines = findings.map((finding) => {
      const stepFile = finding.file?.startsWith("features/steps/") ?? false;
      const where = finding.file === undefined ? "-" : stepFile || finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
      const own = stepFile && finding.code === "step-file-import-failed" ? stepDefinition(finding.file!, finding.message) : finding.message;
      const line = `${finding.severity} ${finding.code} ${where} ${own}`.replace(/nukadoko\.(program|config)\.(ts|rb)/g, "nukadoko.$1.*");
      return sameStepFiles(line);
    });
    return { report: lines.sort().join("\n") };
  },
  claims: [{ actual: "report", compare: "equal", expected: "expected" }],
});

// A message about a step file's definition opens with how its engine names
// it: `defineStep` in TypeScript, the step's class (count_matches.rb is
// CountMatches) in Ruby.
function stepDefinition(file: string, message: string): string {
  const className = path.basename(file, path.extname(file)).split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  for (const opening of ["defineStep ", `${className} `]) {
    if (message.startsWith(opening)) return `<step> ${message.slice(opening.length)}`;
  }
  return message;
}
