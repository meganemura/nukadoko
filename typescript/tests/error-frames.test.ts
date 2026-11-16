import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ERROR_FRAMES, projectFrames } from "../src/run/error-frames.js";

// Responsibility: which frames of a thrown error's stack a failed step
// record keeps as `error.at`.

const root = path.resolve("/work/app");

function thrownWith(...frames: string[]): Error {
  const error = new Error("wrong number of arguments");
  error.stack = ["Error: wrong number of arguments", ...frames.map((frame) => `    at ${frame}`)].join("\n");
  return error;
}

describe("projectFrames", () => {
  it("keeps the project's own frames, relative, with the line and without the column", () => {
    const error = thrownWith(
      `pick (${pathToFileURL(path.join(root, "features/steps/lib/todos.ts")).href}:12:9)`,
      `${path.join(root, "features/steps/add-a-todo.ts")}:7:3`,
      `run (${path.join(root, "node_modules/nukadoko/dist/run/run-scenario.js")}:100:5)`,
      `step (/usr/lib/node/internal.js:1:1)`,
      `async Promise.all (index 0)`,
    );
    expect(projectFrames(error, root)).toEqual(["features/steps/lib/todos.ts:12", "features/steps/add-a-todo.ts:7"]);
  });

  it("keeps each frame once and at most the first few", () => {
    const frames = Array.from({ length: 9 }, (_, i) => `f (${path.join(root, `lib/f${i % 7}.ts`)}:${i}:1)`);
    const kept = projectFrames(thrownWith(...frames, frames[0] ?? ""), root);
    expect(kept).toHaveLength(MAX_ERROR_FRAMES);
    expect(new Set(kept).size).toBe(kept.length);
  });

  it("is empty for a value that is not an Error", () => {
    expect(projectFrames("boom", root)).toEqual([]);
  });
});
