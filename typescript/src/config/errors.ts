// Responsibility: the one error type config loading raises. Kept separate
// from load.ts so callers (CLI, tests) can `instanceof` it without pulling in
// the loader and the module graph it starts.

export class ConfigError extends Error {
  /** The refusal code a CLI refusal carries for this error. */
  readonly code: "config-invalid" | "config-key-removed";
  readonly configPath: string;
  /** The edit that gets past this error, in words, naming the file. */
  readonly fix?: string;
  /** Set only when one command gets past this error as it is written. */
  readonly do?: string;

  // `options.cause` is the loader error itself. The message already
  // includes that error's text, because the CLI prints `message` and
  // nothing else, and the original stays attached so its stack is not
  // dropped on the way out.
  constructor(
    message: string,
    configPath: string,
    hint: { readonly fix?: string; readonly do?: string },
    options?: ErrorOptions & { readonly code?: "config-key-removed" },
  ) {
    super(message, options);
    this.name = "ConfigError";
    this.code = options?.code ?? "config-invalid";
    this.configPath = configPath;
    if (hint.fix !== undefined) this.fix = hint.fix;
    if (hint.do !== undefined) this.do = hint.do;
  }
}
