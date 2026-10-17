import type { CheckIssue } from "./types.js";

/**
 * The `do:` line of the `undefined-step-check-suppressed` warning that step
 * files failing to import cause, built from the findings those failures
 * were reported as. The registry's own line names `step-file-import-failed`,
 * which a missing Playwright package is not reported as, so a project whose
 * only unreadable files lack Playwright would be told to fix a finding that
 * is not in its report.
 */
export function importSuppressionDo(importFindings: readonly Pick<CheckIssue, "code" | "do">[]): string {
  const installs = [
    ...new Set(
      importFindings.flatMap((issue) => (issue.code === "playwright-missing" && issue.do !== undefined ? [issue.do] : [])),
    ),
  ];
  const failed = importFindings.filter((issue) => issue.code === "step-file-import-failed").length;
  const steps: string[] = [];
  if (installs.length > 0) steps.push(`run ${installs.join(" and ")} (see playwright-missing)`);
  if (failed > 0) steps.push(`correct the step-file-import-failed ${failed === 1 ? "error" : "errors"}`);
  const first = steps.join(" and ");
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}, then run nuka check again.`;
}
