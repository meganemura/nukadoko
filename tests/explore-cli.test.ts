import { writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoApp } from "../examples/todo/app/server.js";
import { runCli } from "../src/cli/run-cli.js";
import { copyExampleToTempDir, createCaptureSink, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka explore` against the todo example and its real
// app. The v1 app passes the model and the relation. The v2 app renames
// the field add-todo reads, so the model shrinks to one line and the
// relation prints both scenarios.

function startTodoApp(v2: boolean): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createTodoApp({ v2 });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

// A model whose complete-todo post is wrong on purpose: it says "bread"
// can never be completed. The shortest sequence that shows it adds
// "bread" and completes it.
const WRONG_MODEL = [
  'import { defineModel, modelCommand } from "nukadoko";',
  'import addTodo from "../steps/add-todo.js";',
  'import completeTodo from "../steps/complete-todo.js";',
  "",
  "export default defineModel(() => ({ open: [] as string[] })).commands({",
  '  "add-todo": modelCommand(addTodo)({',
  '    args: (_state, draw) => ({ title: draw.pick(["milk", "eggs", "bread"]) }),',
  "    pre: () => true,",
  "    next: (state, args) => ({ open: [...state.open, args.title] }),",
  "    post: () => true,",
  "  }),",
  '  "complete-todo": modelCommand(completeTodo)({',
  "    args: (state, draw) => ({ title: draw.pick(state.open) }),",
  "    pre: (state) => state.open.length > 0,",
  "    next: (state, args) => ({ open: state.open.filter((title) => title !== args.title) }),",
  '    post: (_state, _args, result) => result.title !== "bread",',
  "  }),",
  "});",
  "",
].join("\n");

describe("nuka explore", () => {
  let server: Server | undefined;
  let rootDir: string;
  let requests = 0;

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await removeTempDir(rootDir);
  });

  async function explore(v2: boolean, args: string[], extraModel?: string, modelFile = "wrong-model.ts") {
    const started = await startTodoApp(v2);
    server = started.server;
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    if (extraModel !== undefined) {
      await writeFile(path.join(rootDir, "features", "explore", modelFile), extraModel);
    }
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "nukadoko";',
        "",
        "export default defineConfig({",
        `  baseURL: "${started.baseURL}",`,
        `  environments: { staging: { baseURL: "${started.baseURL}", policy: "read-only" } },`,
        "});",
        "",
      ].join("\n"),
    );
    requests = 0;
    server.on("request", () => {
      requests += 1;
    });
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["explore", ...args], { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("passes the model against the v1 app, prints nothing on stdout, and names the seed", async () => {
    const result = await explore(false, ["features/explore/add-model.ts", "--seed", "1", "--runs", "5", "--length", "6"]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr:
        "Passed: 5 runs, 30 steps, seed 1. Rerun: nuka explore features/explore/add-model.ts --seed 1 --runs 5 --length 6\n",
    });
  });

  it("prints the one-line scenario the v2 app fails on", async () => {
    const result = await explore(true, ["features/explore/add-model.ts", "--seed", "1", "--runs", "5", "--length", "6"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: [
        "# nuka explore features/explore/add-model.ts --seed 1 --runs 5 --length 6",
        "# Run 1 of 5 failed after 1 step. Shrunk to 1 step in 1 attempt.",
        "  Scenario: (name me)",
        "    # step 1 failed: returns validation failed: title: Invalid input: expected string, received undefined",
        '    * a todo titled "milk" is added',
        "",
      ].join("\n"),
      stderr: "Failed: run 1, seed 1, shrunk to 1 step. The scenario is on stdout.\n",
    });
  });

  it("shrinks a long failing sequence to the two steps a wrong post needs", async () => {
    const result = await explore(false, ["features/explore/wrong-model.ts", "--seed", "1", "--runs", "5", "--length", "8"], WRONG_MODEL);
    expect({ ...result, stdout: result.stdout.replace(/"id":"[0-9a-f-]+"/, '"id":"<id>"') }).toEqual({
      exitCode: 1,
      stdout: [
        "# nuka explore features/explore/wrong-model.ts --seed 1 --runs 5 --length 8",
        "# Run 1 of 5 failed after 7 steps. Shrunk to 2 steps in 12 attempts.",
        "  Scenario: (name me)",
        '    * a todo titled "bread" is added',
        '    # step 2 failed: post of command "complete-todo" returned false for result {"id":"<id>","title":"bread","done":true}',
        '    * the todo titled "bread" is completed',
        "",
      ].join("\n"),
      stderr: "Failed: run 1, seed 1, shrunk to 2 steps. The scenario is on stdout.\n",
    });
  });

  it("prints both scenarios when the relation's source fails", async () => {
    const result = await explore(true, ["features/explore/add-relation.ts"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: [
        "# nuka explore features/explore/add-relation.ts",
        '# Relation "add then listed" failed in its source sequence.',
        '  Scenario: (name me) source of "add then listed"',
        "    # step 1 failed: returns validation failed: title: Invalid input: expected string, received undefined",
        '    * a todo titled "milk" is added',
        "",
        '  Scenario: (name me) follow of "add then listed"',
        '    * the todo list includes "milk"',
        "",
      ].join("\n"),
      stderr: 'Failed: relation "add then listed". Both scenarios are on stdout.\n',
    });
  });

  it("passes the relation against the v1 app", async () => {
    const result = await explore(false, ["features/explore/add-relation.ts"]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: 'Passed: relation "add then listed". Rerun: nuka explore features/explore/add-relation.ts\n',
    });
  });

  it("refuses a mutating step under a read-only environment before any step runs", async () => {
    const result = await explore(false, ["features/explore/add-model.ts", "--env", "staging"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        'Step "add-todo" mutates state but environment "staging" has policy "read-only"\n' +
        'Step "complete-todo" mutates state but environment "staging" has policy "read-only"\n',
    });
    expect(requests).toBe(0);
  });

  it("quotes a file path with a space in the rerun command", async () => {
    const result = await explore(
      false,
      ["features/explore/my model.ts", "--seed", "2", "--runs", "1", "--length", "1"],
      WRONG_MODEL,
      "my model.ts",
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "Passed: 1 run, 1 step, seed 2. Rerun: nuka explore 'features/explore/my model.ts' --seed 2 --runs 1 --length 1\n",
    });
  });

  it("refuses a file that is not a model or a relation, before any step runs", async () => {
    const result = await explore(false, ["features/steps/add-todo.ts"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "features/steps/add-todo.ts is not a model or a relation that discovery found under features. " +
        "Found: features/explore/add-model.ts, features/explore/add-relation.ts\n",
    });
  });
});
