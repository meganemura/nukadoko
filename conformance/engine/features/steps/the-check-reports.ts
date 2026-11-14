import { defineStep, z } from "nukadoko";
import { sameStepFiles } from "./lib/engine.ts";
import nukaRuns from "./nuka-runs.ts";

type Finding = { severity: string; code: string; file?: string; line?: number; message: string };

export default defineStep({
  description:
    "The --json envelope's findings, one line each as severity, code, where, and message, sorted, are exactly the docstring; a step file is written as features/steps/<name>.* with no line, and the program file as nukadoko.program.*",
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
      const message = finding.message.replace(/nukadoko\.(program|config)\.(ts|rb)/g, "nukadoko.$1.*");
      return sameStepFiles(`${finding.severity} ${finding.code} ${where} ${message}`);
    });
    return { report: lines.sort().join("\n") };
  },
  claims: [{ actual: "report", compare: "equal", expected: "expected" }],
});
