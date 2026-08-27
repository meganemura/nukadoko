// Responsibility: strip a Gherkin step keyword off one line of source text,
// so the remainder can be matched against extracted patterns the same way
// nuka run matches a pickle step. Only the step keywords (Given/When/Then/
// And/But/*) are recognised -- Feature:/Scenario:/comments/table rows/blank
// lines are all "not a step line" and return undefined, the same verdict a
// caller gives up on rather than guesses at.
const STEP_KEYWORD_LINE = /^(?:Given|When|Then|And|But|\*)\s+(.+)$/;

export function parseStepLine(lineText: string): string | undefined {
  const match = STEP_KEYWORD_LINE.exec(lineText.trim());
  if (!match) {
    return undefined;
  }
  const stepText = (match[1] ?? "").trim();
  return stepText.length > 0 ? stepText : undefined;
}
