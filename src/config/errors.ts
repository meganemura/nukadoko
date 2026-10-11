// Responsibility: the one error type config loading raises. Kept separate
// from load.ts so callers (CLI, tests) can `instanceof` it without pulling in
// the loader's tsImport dependency.

export class ConfigError extends Error {
  readonly configPath: string;

  // `options.cause` is the loader error itself. The message already
  // includes that error's text, because the CLI prints `message` and
  // nothing else, and the original stays attached so its stack is not
  // dropped on the way out.
  constructor(message: string, configPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}
