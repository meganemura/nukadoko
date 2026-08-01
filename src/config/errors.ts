// Responsibility: the one error type config loading raises. Kept separate
// from load.ts so callers (CLI, tests) can `instanceof` it without pulling in
// the loader's tsImport dependency.

export class ConfigError extends Error {
  readonly configPath: string;

  constructor(message: string, configPath: string) {
    super(message);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}
