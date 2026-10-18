// Responsibility: read a command's `--json` envelope the way most tests
// assert on it, the findings split by severity. A bucket's entries keep
// every key the envelope wrote except `severity`, which the bucket names,
// and the envelope's own fields sit beside the buckets.

export function bySeverity(text: string): any {
  const envelope = JSON.parse(text) as { findings: Array<{ severity: string } & Record<string, unknown>> };
  const pick = (severity: string): any[] =>
    envelope.findings
      .filter((finding) => finding.severity === severity)
      .map(({ severity: _severity, ...rest }) => rest);
  return {
    ...envelope,
    envelope,
    errors: pick("error"),
    warnings: pick("warning"),
    notes: pick("note"),
    refused: pick("refused"),
    failed: pick("failed"),
  };
}
