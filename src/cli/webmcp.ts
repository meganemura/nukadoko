import { loadConfig } from "../config/load-config.js";
import { listWebmcpTools } from "../webmcp/list-tools.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka experimental webmcp-tools <url>`'s CLI-facing
// wiring, kept out of run-cli.ts so it is unit-testable without going
// through yargs, the same split cli/session.ts already follows. This
// command loads the project's config for its `browser`/`browserType`/
// `browserContext` keys only; it never touches step discovery, since the
// tools it reports are deliberately not part of that vocabulary
// (src/webmcp/list-tools.ts's own header).

export interface RunWebmcpToolsOptions {
  rootDir: string;
  url: string;
  json: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runWebmcpTools(options: RunWebmcpToolsOptions): Promise<number> {
  const { rootDir, url, json, stdout, stderr } = options;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  let tools;
  try {
    tools = await listWebmcpTools({ url, config });
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  if (json) {
    stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
  } else {
    // Name and description only, per this surface's own decision to leave
    // `inputSchema` (verbose, and meant to be read as JSON text) to `--json`.
    for (const tool of tools) {
      stdout.write(`${tool.name}\t${tool.description}\n`);
    }
  }
  return 0;
}
