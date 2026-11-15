import { defineStep, z } from "nukadoko";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import theProject from "./the-project.ts";

// What two renders of one run share, and two engines too. A file's name is
// derived from the run id, so each id is written as id-<n> in the order it
// first appears; the times are the run's; the language label names the
// language of the engine that rendered. The results are listed by full
// name and parameters, then the containers, so the order does not depend
// on the names. An attachment is its name and type, and whether its file
// is there: the step record it holds is the engine's own.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function steady(dir: string): string {
  const files = readdirSync(dir).sort();
  const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
  const results = files.filter((name) => name.endsWith("-result.json")).map(read);
  const containers = files.filter((name) => name.endsWith("-container.json")).map(read);
  const order = (result: Record<string, unknown>): string => JSON.stringify([result.fullName, result.parameters]);
  results.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  const ids = new Map<string, string>();
  const named = (value: string): string =>
    value
      .replace(UUID, (id) => {
        if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
        return ids.get(id)!;
      })
      .replace(/\b(run|step)-\d{8}-\d{6}-[a-z0-9]{4}\b/g, "$1-<id>");
  const walk = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.name === "language" && "value" in record) return { name: "language", value: "<language>" };
      if (typeof record.source === "string" && "type" in record) {
        return { name: record.name, file: existsSync(path.join(dir, record.source)) ? "written" : "missing", type: record.type };
      }
      return Object.fromEntries(Object.keys(record).sort().map((name) => [name, walk(record[name], name)]));
    }
    if (key === "start" || key === "stop") return "<time>";
    return typeof value === "string" ? named(value) : value;
  };
  const lines = [
    `categories.json ${JSON.stringify(walk(read("categories.json")))}`,
    `environment.properties ${JSON.stringify(readFileSync(path.join(dir, "environment.properties"), "utf8"))}`,
    ...results.map((result) => `result ${JSON.stringify(walk(result))}`),
  ];
  const shown = containers.map((container) => JSON.stringify(walk(container))).sort();
  return [...lines, ...shown.map((container) => `container ${container}`)].join("\n");
}

export default defineStep({
  description:
    "The Allure results nuka report wrote to a directory of the project: categories.json, environment.properties, each result by full name and parameters, then each container, keys sorted, each id written as id-<n> in the order it first appears and each time as a placeholder, is exactly the docstring",
  pattern: "the allure results in {results:string} are",
  args: z.object({
    results: z.string().describe("The directory, relative to the project"),
    expected: z.string().describe("The results, one file per line"),
    dir: theProject.returns.shape.dir,
  }),
  from: { dir: [theProject, "dir"] },
  observe({}, { results, dir }) {
    return { text: steady(path.join(dir, results)) };
  },
  claims: [{ actual: "text", view: "text", compare: "equal", expected: "expected" }],
});
