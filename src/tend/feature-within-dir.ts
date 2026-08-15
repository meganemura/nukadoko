import path from "node:path";

// Responsibility: the one normalization every "is this feature path inside
// that configured directory" check in this module needs, shared so the
// normalization is written once rather than risking two slightly different
// answers to the same question. A plain string check (`featurePath.
// startsWith(dir)`) would call `features-extra/x.feature` inside `features`
// (`"features-extra".startsWith("features")` is true), which is wrong:
// `path.relative` compares path *segments*, not characters, so the
// disagreement between `features` and `features-extra` surfaces as a
// leading `".."` in the relative path instead, which is what is checked for
// below. An empty relative path (`featurePath === dir` itself) is not
// "inside" either — a directory does not contain itself as a feature file.
export function isFeatureWithinDir(featurePath: string, dir: string): boolean {
  const relative = path.relative(dir, featurePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
