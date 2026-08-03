import { checkBindings } from "../check/binding-check.js";
import { loadConfig } from "../config/load-config.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { loadFeatures } from "../feature/load-features.js";
import { findUnusedFromDeclarations } from "./from-unused.js";
import { findMissingFieldDescriptions } from "./missing-describe.js";
import { findMissingRationale } from "./missing-rationale.js";
import { findUnboundPatternedSteps } from "./pattern-unbound.js";
import { findSignoffRot } from "./signoff-rot.js";
import { resolveStepOccurrences } from "./step-bindings.js";
import { findUnusedParameterTypes } from "./unused-parameter-type.js";
import type { TendIssue, TendReport } from "./types.js";

// Responsibility: the one function `nuka tend` runs — load the project the
// same way `nuka check` does (loadConfig, discoverSteps, loadFeatures) and
// run this task's five note-only findings, in the fixed order below so a
// human reading text output sees findings grouped by kind without this
// module needing to sort anything after the fact (this task's spec: text
// output "種類ごとにまとまっていること" — src/cli/tend.ts pushes each
// category's array through in one block rather than interleaving).
//
// `patterns` is built once, here, via src/check/binding-check.ts's own
// `checkBindings` — the same parsed-pattern array src/check/feature-check.ts
// and src/check/from-order.ts already consume — never rebuilt (this task's
// spec: "三つ目の計算経路を作らない"). Its own `issues`/`warnings` are
// discarded: those are `check`'s findings, not tend's, and a binding error
// (e.g. a broken custom parameter type) just means `patterns` comes back
// empty, which every finding below already treats as "nothing to check"
// rather than crashing.
//
// `discoverSteps` runs tolerant of a broken glue file (`tolerateImportFailures:
// true`, the same flag src/check/analyze.ts passes) so one unreadable step
// file doesn't take down every other finding across the rest of the
// project — the same migrating-suite reasoning that file's own header
// gives, just without this module reporting the import failure itself
// (that stays `check`'s own finding; `tend` silently has one fewer step to
// look at).
//
// `errors` is populated by `findSignoffRot` alone (m8b-tend-signoff-rot task
// spec): sign-off staleness is the one docs/spec.md "Tending" finding marked
// as an error rather than a note (a record that has quietly stopped meaning
// what it says is worse than no record, because it is still being counted),
// and it is the only tend finding that reads outside `vocabulary`/
// `features` — it walks the whole project for acceptance records
// (src/tend/record-parse.ts) and checks each one against this same
// `vocabulary`, never a second one it builds itself.

export async function analyzeTend(rootDir: string): Promise<TendReport> {
  const config = await loadConfig(rootDir);
  const { vocabulary, compatParameterTypes } = await discoverSteps(rootDir, config.featuresDir, {
    tolerateImportFailures: true,
  });

  const { patterns } = checkBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  const { features } = loadFeatures(rootDir, config.featuresDir);
  const occurrences = resolveStepOccurrences(features, patterns);

  const errors: TendIssue[] = [...findSignoffRot(rootDir, vocabulary)];

  const notes: TendIssue[] = [
    ...findUnusedFromDeclarations(vocabulary, occurrences),
    ...findUnboundPatternedSteps(vocabulary, occurrences),
    ...findMissingFieldDescriptions(vocabulary),
    ...findMissingRationale(vocabulary),
    ...findUnusedParameterTypes(vocabulary, config.parameterTypes),
  ];

  return { errors, notes };
}
