import { loadConfig } from "../config/load-config.js";
import { listWebmcpTools } from "../webmcp/list-tools.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";

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
    // Name and description only. `inputSchema` is verbose and meant to be
    // read as JSON text, so it stays on `--json`. A description can contain
    // newlines. Collapsed to single spaces here so the listing stays one
    // line per tool: a later `cut -f1` then reads names, not fragments of
    // the description. `--json` above keeps the description the page
    // declared.
    for (const tool of tools) {
      const description = tool.description.replace(/\s*\n\s*/g, " ");
      stdout.write(`${tool.name}\t${description}\n`);
    }
  }
  return 0;
}
