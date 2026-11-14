import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run.json's `routes` and the summary's "Routes" over a
// real run of tests/fixtures/events-project, whose app/list.mjs lists
// seven invented routes and whose server reports a `request` line for
// each request. Each route the list names stands beside the ones the
// steps requested: one no step requested, a PUT and PATCH pair with one
// handler of which the steps requested one, a request to a route the
// list does not name, and a request the program matched to no route. A
// list that was not read gives no `routes`, and the summary says why.
// Two worlds whose lists name the same routes share one list in the
// summary; two whose lists differ each count their own.

const FEATURE = [
  "Feature: Rooms",
  "",
  "  Scenario: a room is read",
  '    When the client gets "/rooms/7"',
  '    And the client gets "/rooms/8"',
  "",
  "  Scenario: a room is replaced",
  '    When the client puts to "/rooms/7"',
  "",
  "  Scenario: a page the list does not name",
  '    When the client gets "/extra"',
  "",
  "  Scenario: a page no route matches",
  '    When the client gets "/missing"',
  "",
].join("\n");

function program(env = "", environments: readonly string[] = []): string {
  return [
    'import { defineProgram } from "./nukadoko-shim.js";',
    "",
    "export default defineProgram({",
    '  serve: { command: "node app/server.mjs", ready: "/up" },',
    `  env: { PORT: "{port}", ADMIN_TOKEN: "{token}", JOBS_DIR: "{dir}/jobs", EXECUTION_EVENTS: "{events}"${env} },`,
    '  lists: { routes: "node app/list.mjs routes {url}" },',
    ...(environments.length === 0 ? [] : ["  environments: {", ...environments.map((line) => `    ${line}`), "  },"]),
    "});",
    "",
  ].join("\n");
}

async function run(rootDir: string): Promise<number> {
  return runCli(["run", "features/rooms.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
}

const summaryOf = (rootDir: string): string => readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");

/** The summary's "Routes" section, up to the next heading. */
function routesSection(summary: string): string[] {
  const lines = summary.split("\n");
  const start = lines.indexOf("## Routes");
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).filter((line, index, all) => !(line === "" && index === all.length - 1));
}

const counts = (held: number) => ({ held, proven: 0, failed: 0, unproven: 0, moved: 0, controls: 0 });

const criterion = (line: number, name: string, requests: number, status: number) => ({
  feature: "features/rooms.feature",
  line,
  name,
  verdict: "held",
  cells: [{ environment: "default", role: "required", outcome: "pass", requests, statuses: [status] }],
});

describe("run.json's routes", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFile(path.join(rootDir, "features", "rooms.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names every listed route, with the requests head steps sent it, and the requests the list does not account for", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program());
    expect(await run(rootDir)).toBe(0);

    const unrequested = (method: string, route: string, handler: string) => ({
      method,
      route,
      handlers: [handler],
      listed_in: ["default"],
      requests: 0,
      statuses: [],
      criteria: [],
      counts: counts(0),
    });
    expect(latestRunJson(rootDir).routes).toEqual([
      { method: "GET", route: "/extra", handlers: [], listed_in: [], requests: 1, statuses: [200], criteria: [criterion(10, "a page the list does not name", 1, 200)], counts: counts(1) },
      unrequested("GET", "/orders/:id", "orders#show"),
      unrequested("DELETE", "/rooms/:id", "rooms#destroy"),
      {
        method: "GET",
        route: "/rooms/:id",
        handlers: ["rooms#show"],
        listed_in: ["default"],
        requests: 2,
        statuses: [200],
        criteria: [criterion(3, "a room is read", 2, 200)],
        counts: counts(1),
      },
      unrequested("PATCH", "/rooms/:id", "rooms#update"),
      {
        method: "PUT",
        route: "/rooms/:id",
        handlers: ["rooms#update"],
        listed_in: ["default"],
        requests: 1,
        statuses: [200],
        criteria: [criterion(7, "a room is replaced", 1, 200)],
        counts: counts(1),
      },
      unrequested("POST", "/scores", "scores#create"),
      // The readiness probe is no step's request.
      unrequested("GET", "/up", "health#show"),
      { method: "GET", route: null, handlers: [], listed_in: [], requests: 1, statuses: [404], criteria: [criterion(13, "a page no route matches", 1, 404)], counts: counts(1) },
    ]);
    expect(routesSection(summaryOf(rootDir))).toEqual([
      "## Routes",
      "",
      "Head steps requested 2 of the 7 routes the program's routes list names.",
      "A request says which route the program matched, not that a step checked what it answered.",
      "",
      "- Never requested (4): `GET /orders/:id`, `DELETE /rooms/:id`, `POST /scores`, `GET /up`",
      "- Never requested, though a route with its handler was (1): `PATCH /rooms/:id` through `PUT /rooms/:id`",
      "- 1 request to a route its world's list does not name: `GET /extra` 1",
      "- 1 request the program matched to no route: `GET` 1",
    ]);
  });

  it("gives no routes when the list was not read, and the summary says whose", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(', LIST_MODE: "malformed"'));
    expect(await run(rootDir)).toBe(0);

    const document = latestRunJson(rootDir);
    expect(document).not.toHaveProperty("routes");
    expect(document.worlds[0].lists.routes.entries).toBeNull();
    expect(routesSection(summaryOf(rootDir))).toEqual([
      "## Routes",
      "",
      "- World `default` read no routes list (`program-list-unread` under Findings), so none of its routes stands here.",
    ]);
  });

  it("names the program's list once when two worlds list the same routes", async () => {
    const environments = ['"reorder-off": { conditions: { quick_reorder: false } },', '"reorder-on": { conditions: { quick_reorder: true } },'];
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(', QUICK_REORDER: "{condition.quick_reorder}"', environments));
    expect(await run(rootDir)).toBe(0);

    expect(routesSection(summaryOf(rootDir))).toEqual([
      "## Routes",
      "",
      "Head steps requested 2 of the 7 routes the program's routes list names (the same in 2 worlds).",
      "A request says which route the program matched, not that a step checked what it answered.",
      "",
      "- Never requested (4): `GET /orders/:id`, `DELETE /rooms/:id`, `POST /scores`, `GET /up`",
      "- Never requested, though a route with its handler was (1): `PATCH /rooms/:id` through `PUT /rooms/:id`",
      "- 2 requests to a route its world's list does not name: `GET /extra` 2",
      "- 2 requests the program matched to no route: `GET` 2",
    ]);
  });

  it("counts each world's list when two worlds list different routes", async () => {
    const environments = ['"full-list": { conditions: { list_mode: "full" } },', '"short-list": { conditions: { list_mode: "short" } },'];
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(', LIST_MODE: "{condition.list_mode}"', environments));
    expect(await run(rootDir)).toBe(0);

    expect(routesSection(summaryOf(rootDir))).toEqual([
      "## Routes",
      "",
      "Head steps requested 2 of the 7 routes the routes lists of 2 worlds name.",
      "A request says which route the program matched, not that a step checked what it answered.",
      "",
      "- Never requested (4): `GET /orders/:id`, `DELETE /rooms/:id`, `POST /scores`, `GET /up`",
      "- Never requested, though a route with its handler was (1): `PATCH /rooms/:id` through `PUT /rooms/:id`",
      "- 2 requests to a route its world's list does not name: `GET /extra` 2",
      "- 2 requests the program matched to no route: `GET` 2",
    ]);
  });

  it("gives no routes and no section to a run that reads no list", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program().replace('  lists: { routes: "node app/list.mjs routes {url}" },\n', ""));
    expect(await run(rootDir)).toBe(0);

    expect(latestRunJson(rootDir)).not.toHaveProperty("routes");
    expect(routesSection(summaryOf(rootDir))).toEqual([]);
  });
});
