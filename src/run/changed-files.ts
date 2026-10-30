import type { MeasuredChannel, ProcessEntry } from "../record/types.js";
import { describeChangedFiles, directoryOf, selectedChanges, type ChangedFiles } from "../step/define-step.js";
import type { FilesSide } from "../step/evaluate-claims.js";

// Responsibility: the list of paths a claim step's `files` key reads
// (docs/spec.md "Files an earlier step changed"), made from the earlier
// step's record and never from what its code returned: the paths each of
// its `runCommand` processes added, changed, or removed under its working
// directory (`observed.processes[].files`), with the changes and the
// directory the key selects. Pure. It does not choose the earlier step
// (the run and `nuka do --use` do) and does not judge a claim.
//
// A list is made only where every process of the step was measured whole,
// so an absence a claim reads is one nukadoko saw. A step that ran no
// process measured nothing, which is not an empty list. A walk that was not
// made, or a process that left one of its group running when it closed
// (whatever that process writes later is not in the walk), leaves no list.
// Each process lists its paths relative to its own working directory, so
// processes in two directories make no one list. A directory the walk did
// not enter has no paths, so a key that selects inside one has none
// whatever the commands did.

/** The step a files key reads: its record id and its `runCommand`
 * processes as its record lists them (`null` when it ran none), and how a
 * record names it (`<step>@<line>`, or `<step>@<step record id>` under
 * `nuka do`), or why no step can be chosen. */
export type FilesSource = { readonly of: string } & (
  | { readonly record: { readonly step_record_id: string; readonly processes: readonly ProcessEntry[] | null } }
  | { readonly unchosen: string }
);

/** The list `entry` reads from `source`, or why there is none. Pure. */
export function filesSide(entry: ChangedFiles, source: FilesSource): FilesSide {
  const label = `files:${source.of} ${describeChangedFiles(entry)}`;
  if ("unchosen" in source) return { label, unjudged: source.unchosen };
  const of = source.of;
  const processes = source.record.processes ?? [];
  if (processes.length === 0) {
    return { label, unjudged: `${of} ran no runCommand process, so nukadoko measured no file for it, and a list it never measured is not an empty list` };
  }
  for (const [index, process] of processes.entries()) {
    const which = `process ${index + 1} of ${of}`;
    if (process.files === undefined) return { label, unjudged: `the record of ${which} lists no files, so what it changed was not measured` };
    if ("unmeasured" in process.files) return { label, unjudged: `nukadoko did not measure the files ${which} changed: ${process.files.unmeasured}` };
    if (process.group === "running") {
      return { label, unjudged: `${which} left a process of its group running when it closed, so a file that process wrote after the walk is not in the list` };
    }
  }
  const cwds = [...new Set(processes.map((process) => process.cwd))];
  if (cwds.length > 1) {
    return {
      label,
      unjudged: `the commands of ${of} ran in ${cwds.length} working directories, ${cwds.join(" and ")}, and each lists its paths relative to its own, so they make no one list`,
    };
  }
  const changes = selectedChanges(entry);
  const dir = entry.under === undefined ? null : directoryOf(entry.under);
  const paths = new Set<string>();
  for (const [index, process] of processes.entries()) {
    const files = process.files as Exclude<ProcessEntry["files"], undefined | { readonly unmeasured: string }>;
    const unwalked = dir === null ? undefined : files.skipped?.find((skipped) => dir.startsWith(skipped));
    if (unwalked !== undefined) {
      return { label, unjudged: `${dir} is inside ${unwalked}, which process ${index + 1} of ${of} did not walk, so the list is empty whatever it did` };
    }
    for (const change of changes) {
      for (const path of files[change]) if (dir === null || (path.startsWith(dir) && path !== dir)) paths.add(path);
    }
  }
  const measured: MeasuredChannel = {
    step_record_id: source.record.step_record_id,
    channel: processes.length === 1 ? "observed.processes[0].files" : "observed.processes",
  };
  return { label, paths: [...paths].sort(), measured };
}
