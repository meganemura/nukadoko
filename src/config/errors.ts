// Responsibility: the one error type config loading raises. Kept separate
// from load.ts so callers (CLI, tests) can `instanceof` it without pulling in
// the loader and the module graph it starts.

export class ConfigError extends Error {
  readonly configPath: string;
  /** The edit or command that gets past this error. A CLI refusal names it
   * as its `do:` line (src/cli/refusal.ts reads `do` off any error), since
   * a command's `--help` lists no flag that fixes a config. */
  readonly do: string;

  // `options.cause` is the loader error itself. The message already
  // includes that error's text, because the CLI prints `message` and
  // nothing else, and the original stays attached so its stack is not
  // dropped on the way out.
  constructor(message: string, configPath: string, next: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.configPath = configPath;
    this.do = next;
  }
}
