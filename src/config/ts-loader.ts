import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";

// Responsibility: load a project's TypeScript (the config and the step
// files) with Node's own type stripping, each load in a module graph of its
// own. Boundary: two resolve rules in one process-wide hook, and the import
// call; this module transforms no source. It imports only Node builtins, so
// `node --import` can preload it from `src/` as well as from `dist/`.
//
// Why a graph per load: Node keeps one module per URL for the life of the
// process. A second discovery run in the same process (a test file, the
// MCP server, a config edited under a running process) would
// get the first run's step modules back, with their top-level code already
// run, so a compat `Given` would never register again. A load names a
// namespace in the entry URL's query, and the hook copies that query onto
// every file URL the entry reaches, `node_modules` included: a step file's
// `nukadoko/compat` has to land on the same registry instance that
// discovery reads through the same namespace. Inside one namespace a file
// still has one URL, so a step that another step imports is one object
// however it is reached (`ctx.resultOf` keys on that identity).
//
// Why `.js` falls back to `.ts`: a TypeScript project under
// `"module": "nodenext"` writes `./run-greet.js` for `run-greet.ts`, and
// nukadoko's own `src/` does the same. Node resolves only the file that
// exists, so the hook tries the TypeScript name when the JavaScript one is
// missing, and rethrows Node's original error when neither exists, so the
// message still names the specifier the file wrote.
//
// Why the test suite runs this file outside its transform: Vitest rewrites
// a literal `import()` into its own loader, which never reaches Node's
// hooks, so vitest.config.ts lists this file as external and Node loads it.

export const NAMESPACE_PARAM = "nukadoko-namespace";

const SOURCE_EXTENSION: Readonly<Record<string, string>> = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" };
const PATH_WITH_JS_EXTENSION = /^(\.{1,2}\/|\/|file:)(.*?)(\.[mc]?js)([?#].*)?$/s;

/** The TypeScript file a path specifier ending in `.js`, `.mjs`, or `.cjs`
 * stands for, or `null` for any other specifier (a package name, a
 * builtin, another extension). A query or fragment stays in place. */
export function typeScriptSpecifier(specifier: string): string | null {
  const match = PATH_WITH_JS_EXTENSION.exec(specifier);
  if (match === null) return null;
  const [, prefix, stem, extension, suffix = ""] = match;
  return `${prefix}${stem}${SOURCE_EXTENSION[extension!]}${suffix}`;
}

// A process can hold two copies of this module (the CLI from `dist/` and a
// test's `src/`), and each would add a hook; one hook is enough.
const INSTALLED = Symbol.for("nukadoko.ts-loader.installed");

function namespaceOf(url: string | undefined): string | null {
  if (url === undefined || !url.startsWith("file:")) return null;
  return new URL(url).searchParams.get(NAMESPACE_PARAM);
}

if (!(globalThis as Record<symbol, unknown>)[INSTALLED]) {
  (globalThis as Record<symbol, unknown>)[INSTALLED] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let resolved;
      try {
        resolved = nextResolve(specifier, context);
      } catch (error) {
        const alternative = typeScriptSpecifier(specifier);
        if ((error as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND" || alternative === null) throw error;
        try {
          resolved = nextResolve(alternative, context);
        } catch {
          throw error;
        }
      }
      const namespace = namespaceOf(context.parentURL);
      if (namespace === null || !resolved.url.startsWith("file:")) return resolved;
      const url = new URL(resolved.url);
      url.searchParams.set(NAMESPACE_PARAM, namespace);
      return { ...resolved, url: url.href };
    },
  });
}

/** A fresh namespace: every load made with it shares one module graph that
 * no other namespace sees. Random, because loads run concurrently. */
export function newNamespace(): string {
  return randomUUID();
}

/** Imports a file URL inside `namespace`. */
export function importInNamespace(fileUrl: string, namespace: string): Promise<unknown> {
  const url = new URL(fileUrl);
  url.searchParams.set(NAMESPACE_PARAM, namespace);
  return import(url.href);
}

/** Node's message names a namespaced URL; the reader wrote the path
 * without the query. */
export function withoutNamespace(text: string): string {
  return text.replace(new RegExp(`\\?${NAMESPACE_PARAM}=[0-9a-f-]+`, "g"), "");
}

/** This module's own URL, for `node --import` in a child process: `.ts`
 * from `src/`, `.js` from `dist/`. */
export const loaderUrl: string = import.meta.url;
