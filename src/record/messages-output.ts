import path from "node:path";

// Responsibility: the file name a cucumber-messages stream gets for one
// run. Retention deletes that file, `nuka clean` deletes every such file,
// and the emitter writes it. The naming rule sits here, with the records
// those commands are cleaning, so the record module does not import the
// emitter to learn a path the emitter itself only applies.

/** The file the messages emitter writes for one invocation: `output`
 * with its own basename (extension stripped) followed by `.<runId>.ndjson`,
 * beside `output` itself. Always a literal `.ndjson` extension, regardless
 * of `output`'s own. The name only needs to be unique and self-describing,
 * not to mirror a user-chosen extension. */
export function messagesRunOutputPath(output: string, runId: string): string {
  const base = path.basename(output, path.extname(output));
  return path.join(path.dirname(output), `${base}.${runId}.ndjson`);
}

/** True for any file this naming produces beside `output` for some run id,
 * never for `output` itself. `output` can be relocated to a user-owned
 * directory (`messages.output` in `nukadoko.config.ts`), so this only
 * matches on the one part of a run id's own format (src/run/run-id.ts)
 * that is safe to depend on here, its `run-` prefix. Matching any
 * `<base>.<anything>.ndjson` instead would let `nuka clean` delete an
 * unrelated file a project happens to keep beside its own configured path
 * (for example a hand-kept `messages.backup.ndjson`). */
export function isMessagesRunOutputFileName(output: string, candidateFileName: string): boolean {
  if (candidateFileName === path.basename(output)) {
    return false;
  }
  const base = path.basename(output, path.extname(output));
  return candidateFileName.startsWith(`${base}.run-`) && candidateFileName.endsWith(".ndjson");
}
