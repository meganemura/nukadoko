import type { z } from "zod";

// Responsibility: turn a zod safeParse failure's issues into the one-line
// message a failed receipt's `error.message` carries (docs/spec.md
// "Receipts") — shared between `nuka do` (src/cli/do.ts) and `nuka run`
// (src/run/run-scenario.ts) so the wording is identical for a step run
// either way, rather than two copies drifting apart.

export function formatValidationIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${key}: ${issue.message}`;
    })
    .join("; ");
}
