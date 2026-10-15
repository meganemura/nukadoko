import type { CompatParameterTypeEntry } from "../discover/discover-steps.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s "A defineParameterType still
// registered from support code" finding — moved here from
// src/check/binding-check.ts's own `parameter-type-support-origin` warning
// (docs/spec.md "Tending": "This one used to be a `nuka check` warning,
// which was a mis-sort"). It keeps
// working, and `config.parameterTypes` is its typed-era home; moving the
// registration changes no match, except for one that sets
// `preferForRegexpMatch`. Config rejects that key, so such a registration
// stays in support code while a RegExp step relies on it. It fires for as long as a suite has any
// compat left, which is a normal in-progress state, not something that
// should reappear on every `check` run and teach readers to skim past the
// line that does have to be fixed today.
//
// `checkBindings` (src/check/binding-check.ts) is unchanged by this move —
// still the one place compat-origin registrations are collected into the
// registry every pattern is checked against; this module only reads the
// same `compatParameterTypes` list src/tend/analyze.ts already gets from
// `discoverSteps` for that call, and turns each entry into a note instead
// of check's warning.

function supportOriginParameterTypeNote(entry: CompatParameterTypeEntry): TendIssue {
  if (entry.preferForRegexpMatch === true) {
    return {
      code: "parameter-type-support-origin",
      message: `Custom parameter type "${entry.name}" is registered from compat ("support") code at ${entry.filePath} with preferForRegexpMatch: keep it in support code while a RegExp step relies on that preference; config.parameterTypes rejects the key, and without it a RegExp group that another type also matches fails again`,
      file: entry.filePath,
    };
  }
  return {
    code: "parameter-type-support-origin",
    message: `Custom parameter type "${entry.name}" is registered from compat ("support") code at ${entry.filePath}, not from config.parameterTypes: config is the typed-era home for parameter type registrations; both share one registry today, so moving this one is a safe, meaning-preserving step whenever it's convenient`,
    file: entry.filePath,
  };
}

export function findSupportOriginParameterTypes(
  compatParameterTypes: readonly CompatParameterTypeEntry[],
): TendIssue[] {
  return compatParameterTypes.map(supportOriginParameterTypeNote);
}
