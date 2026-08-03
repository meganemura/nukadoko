// Responsibility: the required-env tally docs/spec.md's "Receipts"
// (`required_env`) and "Context API" (`ctx.requireEnv`) describe — which
// env var names an execution actually asked for through `ctx.requireEnv`,
// the one call site the library controls (env-reads-and-mutates-doc task
// spec, item A). Its own file for the same reason used.ts is its own file:
// create-context.ts is the one module that both wires `requireEnv` and owns
// the step boundary, so it is the only caller of both `record` (inside the
// `requireEnv` wrapper, never itself exposed on `ctx`) and `reset`
// (`beginStep`, once per `nuka run` pickle step; `nuka do`'s single
// execution-wide boundary never resets it).
//
// Deduplicated and in read order, the same convention `used` follows — a
// step that requires the same name twice must not cite it twice in
// `required_env`. Names only,
// never values: a value can be a secret, and this collector never sees one
// (`requireEnv`'s own wrapper records the name before it returns the value
// or throws).

export interface EnvReadsCollector {
  /** Tallies one `ctx.requireEnv(name)` call by the name it was given —
   * whether that call goes on to return a value or throw `MissingEnvError`.
   * Recorded before the throw (create-context.ts's `requireEnv`), so a
   * failed-for-missing-env execution's receipt still shows what it asked
   * for. */
  record(name: string): void;
  /** The names read since the last `reset()` (or since creation),
   * deduplicated, in the order first read. */
  snapshot(): string[];
  /** Executor-only: zeroes the tally at a step boundary. */
  reset(): void;
}

export function createEnvReadsCollector(): EnvReadsCollector {
  let seen = new Set<string>();
  let order: string[] = [];

  return {
    record(name: string): void {
      if (!seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    },
    snapshot(): string[] {
      return [...order];
    },
    reset(): void {
      seen = new Set<string>();
      order = [];
    },
  };
}
