/**
 * The `do:` line of `no-step-files-found`, built from the feature files whose
 * lines the same report calls `undefined-step`. With no step file, every line
 * of every checked feature is undefined, so scaffolding those files is the
 * one command that adds the step files the finding asks for. Run per file,
 * in order, a later run sees the stubs an earlier one wrote, so no line gets
 * two stubs. A project whose step files sit outside featuresDir needs them
 * moved instead, which the second sentence says because nothing here can
 * tell the two projects apart.
 */
export function noStepFilesDo(undefinedLineFiles: readonly string[], featuresDir: string): string | undefined {
  const files = [...new Set(undefinedLineFiles)];
  if (files.length === 0) return undefined;
  const scaffold =
    files.length === 1
      ? `Run nuka scaffold --feature ${files[0]}`
      : `Run nuka scaffold --feature for each of ${files.join(", ")}`;
  return `${scaffold}. Step files outside "${featuresDir}" are never read: move any there instead.`;
}
