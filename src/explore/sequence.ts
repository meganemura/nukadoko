// Responsibility: the shapes a model run and a relation run share. A
// sequence is a list of step names with their args. Running one needs only
// `OpenSequence`, so the loops in explore-model.ts and explore-relation.ts
// never see a ctx, a fixture, or a record, and a test can hand them an
// in-memory system.

export interface PlannedStep {
  readonly name: string;
  readonly args: unknown;
}

export type StepOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly message: string };

/** One sequence's world: everything a run opens for it is closed by
 * `close`, so the next sequence starts from what `open` builds, not from
 * what the last sequence left. The target system is not reset. */
export interface SequenceSession {
  run(name: string, args: unknown): Promise<StepOutcome>;
  close(): Promise<void>;
}

export type OpenSequence = () => Promise<SequenceSession>;

export interface SequenceFailure {
  /** 0-based position of the step that failed. */
  readonly index: number;
  readonly message: string;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
