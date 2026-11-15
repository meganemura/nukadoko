import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import path from "node:path";
import theProject from "./the-project.ts";

// What two renders of one run share, and two engines too: the ids are
// random, the times are the run's, and meta names the engine that wrote
// the stream, so each is written as a placeholder. An attachment body that
// holds JSON is read as JSON, so its keys are sorted with the rest.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function steady(text: string): string {
  const ids = new Map<string, string>();
  const named = (value: string): string =>
    value
      .replace(UUID, (id) => {
        if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
        return ids.get(id)!;
      })
      .replace(/\b(run|step)-\d{8}-\d{6}-[a-z0-9]{4}\b/g, "$1-<id>")
      .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z\b/g, "<time>");
  const walk = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if ("seconds" in record && "nanos" in record) return "<time>";
      return Object.fromEntries(Object.keys(record).sort().map((name) => [name, walk(record[name], name)]));
    }
    if (key === "after_reading_ms") return "<ms>";
    if (typeof value === "string") return key === "body" && value.startsWith("{") ? walk(JSON.parse(value)) : named(value);
    return value;
  };
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      return "meta" in envelope ? '{"meta":"<meta>"}' : JSON.stringify(walk(envelope));
    })
    .join("\n");
}

export default defineStep({
  description:
    "A cucumber-messages stream nuka report wrote to a file of the project, one envelope per line with its keys sorted, each id written as id-<n> in the order it first appears, each time and the meta envelope as placeholders, is exactly the docstring",
  pattern: "the messages stream in {file:string} is",
  args: z.object({
    file: z.string().describe("The file, relative to the project"),
    expected: z.string().describe("The stream, one envelope per line"),
    dir: theProject.returns.shape.dir,
  }),
  from: { dir: [theProject, "dir"] },
  observe({}, { file, dir }) {
    return { text: steady(readFileSync(path.join(dir, file), "utf8")) };
  },
  claims: [{ actual: "text", view: "text", compare: "equal", expected: "expected" }],
});
