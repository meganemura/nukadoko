import path from "node:path";
import type { NukadokoConfig } from "./schema.js";

// Responsibility: where each report emitter of `nuka run` writes, and
// whether it runs at all, decided once from the config for the three places
// that start emitters (the single-process run, the concurrent coordinator,
// and each concurrent worker). Resolves root-relative paths only; creating
// or writing anything stays with the emitters.
//
// An emitter is on exactly when its key is present: `allure: {}` or
// `messages: {}`. Off is the default because most projects that run
// nukadoko beside their unit tests read neither export, and a two-step
// scenario used to leave a dozen files behind for nobody.

export interface EmitterTargets {
  /** The Allure results directory, or `null` when `allure` is not set. */
  readonly allureResultsDir: string | null;
  /** The messages stream's stable path, or `null` when `messages` is not set. */
  readonly messagesOutput: string | null;
}

export function emitterTargets(config: Pick<NukadokoConfig, "stateDir" | "allure" | "messages">): EmitterTargets {
  return {
    allureResultsDir:
      config.allure === undefined ? null : (config.allure.resultsDir ?? defaultAllureResultsDir(config.stateDir)),
    messagesOutput: config.messages === undefined ? null : messagesOutputPath(config),
  };
}

export function defaultAllureResultsDir(stateDir: string): string {
  return path.join(stateDir, "export", "allure-results");
}

/** The messages stream's path whether or not the emitter is on. Retention
 * and `nuka clean` remove run files from here, which a run from before the
 * emitter was turned off may have left. */
export function messagesOutputPath(config: Pick<NukadokoConfig, "stateDir" | "messages">): string {
  return config.messages?.output ?? path.join(config.stateDir, "export", "messages.ndjson");
}
