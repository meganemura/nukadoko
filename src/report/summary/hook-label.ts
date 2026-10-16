import { hookDisplayTitle, type ScenarioHookRecord } from "../../record/scenario-record.js";

// Responsibility: the one name a Before, After, or AfterStep hook goes by in
// a Markdown document about a run (the run summary and the acceptance
// record), so the two never name the same hook differently.
//
// A switch with a `never` default rather than a ternary: a ternary is what
// once let `"after_step"` render as "After hook". If the hook type grows a
// fourth value, this stops compiling instead of mislabeling it. The step
// index is part of the label so a reader scanning headings does not have to
// open the JSON body to learn which step an AfterStep hook followed.
export function hookLabel(hook: Pick<ScenarioHookRecord, "type" | "name" | "step_index">): string {
  switch (hook.type) {
    case "before":
      return hookDisplayTitle("Before hook", hook.name);
    case "after":
      return hookDisplayTitle("After hook", hook.name);
    case "after_step":
      return hookDisplayTitle(`AfterStep hook (step ${hook.step_index})`, hook.name);
    default: {
      const exhaustive: never = hook.type;
      throw new Error(`unhandled hook type ${String(exhaustive)}`);
    }
  }
}
