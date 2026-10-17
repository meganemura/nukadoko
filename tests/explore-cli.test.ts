import { readdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoApp } from "../examples/todo/app/server.js";
import { runCli } from "../src/cli/run-cli.js";
import { copyExampleToTempDir, createCaptureSink, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka experimental explore` against the todo example and its real
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
  'import { experimental_defineModel, experimental_modelCommand } from "nukadoko";',
  'import addTodo from "../steps/add-todo.js";',
  'import completeTodo from "../steps/complete-todo.js";',
  "",
  "export default experimental_defineModel(() => ({ open: [] as string[] })).commands({",
  '  "add-todo": experimental_modelCommand(addTodo)({',
  '    args: (_state, draw) => ({ title: draw.pick(["milk", "eggs", "bread"]) }),',
  "    pre: () => true,",
  "    next: (state, args) => ({ open: [...state.open, args.title] }),",
  "    post: () => true,",
  "  }),",
  '  "complete-todo": experimental_modelCommand(completeTodo)({',
  "    args: (state, draw) => ({ title: draw.pick(state.open) }),",
  "    pre: (state) => state.open.length > 0,",
  "    next: (state, args) => ({ open: state.open.filter((title) => title !== args.title) }),",
  '    post: (_state, _args, result) => result.title !== "bread",',
  "  }),",
  "});",
  "",
].join("\n");

describe("nuka experimental explore", () => {
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
    const exitCode = await runCli(["experimental", "explore", ...args], { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("passes the model against the v1 app, prints nothing on stdout, and names the seed", async () => {
    const result = await explore(false, ["features/explore/add-model.ts", "--seed", "1", "--runs", "5", "--length", "6"]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr:
        "Passed: 5 runs, 30 steps, seed 1. Rerun: nuka experimental explore features/explore/add-model.ts --seed 1 --runs 5 --length 6\n",
    });
  });

  it("prints the one-line scenario the v2 app fails on", async () => {
    const result = await explore(true, ["features/explore/add-model.ts", "--seed", "1", "--runs", "5", "--length", "6"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: [
        "# nuka experimental explore features/explore/add-model.ts --seed 1 --runs 5 --length 6",
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
        "# nuka experimental explore features/explore/wrong-model.ts --seed 1 --runs 5 --length 8",
        "# Run 1 of 5 failed after 7 steps. Shrunk to 2 steps in 13 attempts.",
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
        "# nuka experimental explore features/explore/add-relation.ts",
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
      stderr: 'Passed: relation "add then listed". Rerun: nuka experimental explore features/explore/add-relation.ts\n',
    });
  });

  it("refuses a mutating step under a read-only environment before any step runs", async () => {
    const result = await explore(false, ["features/explore/add-model.ts", "--env", "staging"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        'Step "add-todo" mutates state but environment "staging" has policy "read-only"\n' +
        'Step "complete-todo" mutates state but environment "staging" has policy "read-only"\n' +
        "do: nuka experimental explore --help\n",
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
      stderr: "Passed: 1 run, 1 step, seed 2. Rerun: nuka experimental explore 'features/explore/my model.ts' --seed 2 --runs 1 --length 1\n",
    });
  });

  it("prints one JSON object for a passing model", async () => {
    const result = await explore(false, ["features/explore/add-model.ts", "--seed", "1", "--runs", "5", "--length", "6", "--json"]);
    expect({ ...result, stdout: JSON.parse(result.stdout) }).toEqual({
      exitCode: 0,
      stdout: {
        schema_version: 1,
        kind: "model",
        file: "features/explore/add-model.ts",
        verdict: "passed",
        seed: 1,
        runs: 5,
        length: 6,
        steps: 30,
        rerun: "nuka experimental explore features/explore/add-model.ts --seed 1 --runs 5 --length 6",
      },
      stderr:
        "Passed: 5 runs, 30 steps, seed 1. Rerun: nuka experimental explore features/explore/add-model.ts --seed 1 --runs 5 --length 6\n",
    });
  });

  it("prints the shrunk sequence's step results and failure as JSON for a failing model", async () => {
    const result = await explore(
      false,
      ["features/explore/wrong-model.ts", "--seed", "1", "--runs", "5", "--length", "8", "--json"],
      WRONG_MODEL,
    );
    const json = JSON.parse(result.stdout.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"));
    expect({ ...result, stdout: json }).toEqual({
      exitCode: 1,
      stdout: {
        schema_version: 1,
        kind: "model",
        file: "features/explore/wrong-model.ts",
        verdict: "failed",
        seed: 1,
        runs: 5,
        length: 8,
        rerun: "nuka experimental explore features/explore/wrong-model.ts --seed 1 --runs 5 --length 8",
        run: 1,
        found_steps: 7,
        shrunk_steps: 2,
        shrink_attempts: 13,
        failure: {
          index: 1,
          kind: "post-false",
          command: "complete-todo",
          message: 'post of command "complete-todo" returned false for result {"id":"<id>","title":"bread","done":true}',
        },
        steps: [
          { step: "add-todo", args: { title: "bread" }, status: "passed", result: { id: "<id>", title: "bread", done: false } },
          { step: "complete-todo", args: { title: "bread" }, status: "passed", result: { id: "<id>", title: "bread", done: true } },
        ],
        scenario: [
          "  Scenario: (name me)",
          '    * a todo titled "bread" is added',
          '    # step 2 failed: post of command "complete-todo" returned false for result {"id":"<id>","title":"bread","done":true}',
          '    * the todo titled "bread" is completed',
          "",
        ].join("\n"),
      },
      stderr: "Failed: run 1, seed 1, shrunk to 2 steps. The scenario is on stdout.\n",
    });
  });

  it("prints both sequences' step results as JSON for a failing relation", async () => {
    const result = await explore(true, ["features/explore/add-relation.ts", "--json"]);
    expect({ ...result, stdout: JSON.parse(result.stdout) }).toEqual({
      exitCode: 1,
      stdout: {
        schema_version: 1,
        kind: "relation",
        file: "features/explore/add-relation.ts",
        name: "add then listed",
        verdict: "failed",
        rerun: "nuka experimental explore features/explore/add-relation.ts",
        failure: {
          sequence: "source",
          index: 0,
          message: "returns validation failed: title: Invalid input: expected string, received undefined",
        },
        source: {
          steps: [
            {
              step: "add-todo",
              args: { title: "milk" },
              status: "failed",
              message: "returns validation failed: title: Invalid input: expected string, received undefined",
            },
          ],
          scenario: [
            '  Scenario: (name me) source of "add then listed"',
            "    # step 1 failed: returns validation failed: title: Invalid input: expected string, received undefined",
            '    * a todo titled "milk" is added',
            "",
          ].join("\n"),
        },
        follow: {
          steps: [{ step: "todo-list-includes", args: { title: "milk" }, status: "not-run" }],
          scenario: ['  Scenario: (name me) follow of "add then listed"', '    * the todo list includes "milk"', ""].join("\n"),
        },
      },
      stderr: 'Failed: relation "add then listed". Both scenarios are on stdout.\n',
    });
  });

  it("leaves the state directory and what nuka tend reads unchanged after a failing explore", async () => {
    const started = await startTodoApp(false);
    server = started.server;
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await writeFile(path.join(rootDir, "features", "explore", "wrong-model.ts"), WRONG_MODEL);
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      ['import { defineConfig } from "nukadoko";', "", `export default defineConfig({ baseURL: "${started.baseURL}" });`, ""].join("\n"),
    );
    const cli = async (args: string[]) => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(args, { rootDir, stdout, stderr });
      return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
    };
    expect((await cli(["run", "features/todo.feature", "--quiet"])).exitCode).toBe(0);
    const tendBefore = await cli(["tend", "--json"]);
    const stateBefore = (await readdir(path.join(rootDir, ".nukadoko"), { recursive: true })).sort();

    const explored = await cli(["experimental", "explore", "features/explore/wrong-model.ts", "--seed", "1", "--runs", "5", "--length", "8", "--json"]);
    expect(JSON.parse(explored.stdout).verdict).toBe("failed");

    expect((await readdir(path.join(rootDir, ".nukadoko"), { recursive: true })).sort()).toEqual(stateBefore);
    expect(await cli(["tend", "--json"])).toEqual(tendBefore);
  });

  it("prints a table and a docstring that nuka run reads back to the same args", async () => {
    const noteStep = [
      'import { defineStep, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  pattern: "a todo is added with this title",',
      '  description: "Create a todo whose title is the docstring",',
      "  args: z.object({ title: z.string() }),",
      "  returns: z.object({ title: z.string() }),",
      "  mutates: true,",
      "  async run({ request }, args) {",
      '    const res = await request.post("/todos", { data: { title: args.title } });',
      "    return { title: ((await res.json()) as { title: string }).title };",
      "  },",
      "});",
      "",
    ].join("\n");
    const attachedModel = [
      'import { experimental_defineModel, experimental_modelCommand } from "nukadoko";',
      'import addTodos from "../steps/add-todos-from-table.js";',
      'import addNote from "../steps/add-note.js";',
      "",
      "export default experimental_defineModel(() => ({ tables: 0 })).commands({",
      '  "add-todos-from-table": experimental_modelCommand(addTodos)({',
      '    args: (_state, draw) => ({ todos: draw.pick([[["pipe | in a cell"], ["back\\\\slash"]]]) }),',
      "    pre: () => true,",
      "    next: (state) => ({ tables: state.tables + 1 }),",
      "    post: () => true,",
      "  }),",
      '  "add-note": experimental_modelCommand(addNote)({',
      "    args: (_state, draw) => ({ title: draw.pick([\"first line\\n\\\"\\\"\\\"\\nthird line\"]) }),",
      "    pre: () => true,",
      "    next: (state) => state,",
      "    post: (state) => state.tables === 0,",
      "  }),",
      "});",
      "",
    ].join("\n");
    const started = await startTodoApp(false);
    server = started.server;
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await writeFile(path.join(rootDir, "features", "steps", "add-note.ts"), noteStep);
    await writeFile(path.join(rootDir, "features", "explore", "attached-model.ts"), attachedModel);
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      ['import { defineConfig } from "nukadoko";', "", `export default defineConfig({ baseURL: "${started.baseURL}" });`, ""].join("\n"),
    );
    const cli = async (args: string[]) => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(args, { rootDir, stdout, stderr });
      return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
    };

    const explored = await cli(["experimental", "explore", "features/explore/attached-model.ts", "--seed", "1", "--runs", "5", "--length", "4", "--json"]);
    const json = JSON.parse(explored.stdout) as { scenario: string; steps: { step: string; args: unknown }[] };
    expect(json.scenario).toBe(
      [
        "  Scenario: (name me)",
        "    * the following todos are added",
        "      | pipe \\| in a cell |",
        "      | back\\\\slash |",
        '    # step 2 failed: post of command "add-note" returned false for result {"title":"first line\\n\\"\\"\\"\\nthird line"}',
        "    * a todo is added with this title",
        '      """',
        "      first line",
        '      \\"\\"\\"',
        "      third line",
        '      """',
        "",
      ].join("\n"),
    );

    await writeFile(path.join(rootDir, "features", "pasted.feature"), `Feature: pasted\n\n${json.scenario}`);
    expect((await cli(["run", "features/pasted.feature", "--quiet"])).exitCode).toBe(0);
    const recordsDir = path.join(rootDir, ".nukadoko", "records", "steps");
    const records = await Promise.all(
      (await readdir(recordsDir)).map(async (id) =>
        JSON.parse(await readFile(path.join(recordsDir, id, "record.json"), "utf8")) as { step: string; args: unknown; started_at: string },
      ),
    );
    const ran = records.sort((a, b) => a.started_at.localeCompare(b.started_at)).map(({ step, args }) => ({ step, args }));
    expect(ran).toEqual(json.steps.map(({ step, args }) => ({ step, args })));
    expect(ran).toEqual([
      { step: "add-todos-from-table", args: { todos: [["pipe | in a cell"], ["back\\slash"]] } },
      { step: "add-note", args: { title: 'first line\n"""\nthird line' } },
    ]);
  });

  it("refuses a file that is not a model or a relation, before any step runs", async () => {
    const result = await explore(false, ["features/steps/add-todo.ts"]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "features/steps/add-todo.ts is not a model or a relation that discovery found under features. " +
        "Found: features/explore/add-model.ts, features/explore/add-relation.ts\n" +
        "do: nuka experimental explore --help\n",
    });
  });
});

describe("nuka explore", () => {
  it("runs nothing and names the experimental spelling", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["explore", "features/explore/add-model.ts", "--seed", "1"], { stdout, stderr });
    expect({ exitCode, stdout: stdout.text(), stderr: stderr.text() }).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "`nuka explore` moved to `nuka experimental explore`; run that instead, with the same arguments\n" +
        "do: nuka experimental explore --help\n",
    });
  });
});
