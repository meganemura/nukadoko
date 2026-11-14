import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getCallSites } from "node:util";

// Responsibility: tell a file write Playwright's own server-side code made
// from one the step's code asked for, by the code that made the call
// (docs/spec.md "Records", `observed.files`). The `node:fs` patch
// (channels.ts) asks it, and only for a path the step's record would
// otherwise list.
//
// Why the code and not the directory: Playwright's server runs in the
// step's process, and a client call the step makes (a click) reaches the
// server in the step's async context, so the server's trace, network log,
// and HAR writes look like the step's own. A browser nukadoko launches
// writes them under a directory nukadoko names, but a browser a compat
// World launched itself writes them wherever Playwright chose, and a trace
// chunk holds the context's headers and credentials. The directory's name
// would be a guess; the module that called `fs` is a measurement.
//
// The layers, from Playwright's own sources: the client (`src/client/`)
// writes a file the step named, such as `page.screenshot({ path })` or
// `context.storageState({ path })`. The dispatcher layer
// (`src/server/dispatchers/`) carries out a client call on the server
// side with the path the client passed, such as `download.saveAs(path)`.
// `src/server/localUtils.ts` counts with it: it carries out the
// LocalUtils channel, the file work a client call asks for with the
// client's path, such as the zip `tracing.stop({ path })` writes. The rest
// of the server writes where Playwright chose, or where a context option
// chose before the page ran: traces, network logs, resources, a HAR, a
// video. Shared helpers (`packages/utils`,
// bundled third-party code, and the like) belong to whichever layer called
// them, so the walk passes over them to the first frame that decides.
//
// Playwright 1.61 bundles its sources into `lib/coreBundle.js`, with a
// comment line naming each source module where it starts, so a frame's
// line in the bundle names its module. Older layouts kept one file per
// module under `lib/`, and the path names it directly. A frame nukadoko
// cannot place counts as the step's: a write wrongly kept is visible in
// the record, and a write wrongly dropped is not.

/** Where in Playwright a frame of the call stack sits. */
export type Layer = "client" | "dispatcher" | "server" | "helper";

/** The layer of one of Playwright's source modules, from its path in
 * Playwright's sources (`packages/playwright-core/src/server/...`) or in
 * an unbundled `lib/` (`server/...`). */
export function layerOfModule(modulePath: string): Layer {
  const inside = modulePath.replace(/^packages\/playwright-core\/src\//, "");
  if (inside.startsWith("client/")) return "client";
  if (inside.startsWith("server/dispatchers/") || inside === "server/localUtils.ts" || inside === "server/localUtils.js") return "dispatcher";
  if (inside.startsWith("server/")) return "server";
  return "helper";
}

/** What a call stack says about who made a write: a frame decided for
 * Playwright's server or for the step, or no frame decided because the
 * stack holds only Playwright's shared helpers, or no frame at all
 * outside Node and nukadoko. */
export type Verdict = "server" | "step" | "helpers only" | "no frame";

/** The verdict of a call stack whose frames, innermost first, have these
 * layers (`undefined` for a frame outside Playwright). The first frame
 * that is not a shared helper decides. */
export function verdictOf(layers: readonly (Layer | undefined)[]): Verdict {
  for (const layer of layers) {
    if (layer === "helper") continue;
    return layer === "server" ? "server" : "step";
  }
  return layers.length === 0 ? "no frame" : "helpers only";
}

const PLAYWRIGHT_LIB = /[\\/]playwright-core[\\/]lib[\\/](.+)$/;
const MODULE_COMMENT = /^\/\/ ((?:packages|node_modules)\/\S+)$/;

type ModuleStart = { readonly line: number; readonly layer: Layer };

/** Each bundle's module starts, by line, read once per bundle file;
 * `null` for a bundle that could not be read. */
const bundles = new Map<string, readonly ModuleStart[] | null>();

function bundleModules(file: string): readonly ModuleStart[] | null {
  const known = bundles.get(file);
  if (known !== undefined) return known;
  let starts: ModuleStart[] | null = [];
  try {
    const lines = readFileSync(file.startsWith("file:") ? new URL(file) : file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = MODULE_COMMENT.exec(lines[index]!);
      if (match !== null) starts.push({ line: index + 1, layer: layerOfModule(match[1]!) });
    }
  } catch {
    starts = null;
  }
  bundles.set(file, starts);
  return starts;
}

/** The layer of the module a bundle's `line` falls in. A line before the
 * first module comment is the bundler's own glue, a helper. */
function layerAtLine(starts: readonly ModuleStart[], line: number): Layer {
  let low = 0;
  let high = starts.length - 1;
  let found: Layer = "helper";
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle]!.line <= line) {
      found = starts[middle]!.layer;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** A frame's layer, `undefined` outside Playwright or in a bundle that
 * could not be read. A file directly under `lib/` is a bundle (or the
 * bundler's glue, with no module comment at all); a file deeper down is
 * one module of an unbundled layout. `scriptName` is a path, or a file
 * URL for a module loaded as ESM. */
function layerOfFrame(scriptName: string, line: number): Layer | undefined {
  const match = PLAYWRIGHT_LIB.exec(scriptName);
  if (match === null) return undefined;
  const inLib = match[1]!.replaceAll("\\", "/");
  if (inLib.includes("/")) return layerOfModule(inLib);
  const starts = bundleModules(scriptName);
  return starts === null ? undefined : layerAtLine(starts, line);
}

const OWN_URL = new URL(".", import.meta.url).href;
const OWN_DIR = fileURLToPath(OWN_URL);

/** The layers of the frames below this module, innermost first, read
 * from at most `limit` frames; `whole` is false when the stack had more. */
function layersOfStack(limit: number): { readonly layers: (Layer | undefined)[]; readonly whole: boolean } {
  const sites = getCallSites(limit, { sourceMap: false });
  const layers: (Layer | undefined)[] = [];
  for (const site of sites) {
    const name = site.scriptName;
    if (name === "" || name.startsWith("node:") || name.startsWith(OWN_URL) || name.startsWith(OWN_DIR)) continue;
    layers.push(layerOfFrame(name, site.lineNumber));
  }
  return { layers, whole: sites.length < limit };
}

/** Whether the `node:fs` call being made now was made by Playwright's own
 * server-side code. Node's own frames and nukadoko's are passed over: the
 * caller is the first frame outside both. A stack of Playwright's shared
 * helpers alone is the server's, since only its own machinery runs them
 * with nothing of a client call above (a queued trace write). Source maps
 * stay off, so a frame names the file that runs, the file the module
 * comments and this module's own directory describe.
 *
 * Reading frames costs about 2 microseconds each, and this runs once per
 * new path a step writes, so a short stack is read first and a longer one
 * only when no frame of the short one decided. */
export function writeMadeByPlaywrightServer(): boolean {
  let stack = layersOfStack(12);
  let verdict = verdictOf(stack.layers);
  if (!stack.whole && (verdict === "helpers only" || verdict === "no frame")) {
    stack = layersOfStack(64);
    verdict = verdictOf(stack.layers);
  }
  return verdict === "server" || verdict === "helpers only";
}
