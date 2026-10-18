import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { SCHEMA_VERSIONS, versioned, type DocumentKind } from "../src/record/schema-version.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: every document kind in SCHEMA_VERSIONS, produced the way a
// user produces it, starts with its own `schema_version`, and the records
// and run.json also name the nukadoko version that wrote them.

async function cli(rootDir: string, argv: string[]): Promise<string> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  await runCli(argv, { rootDir, stdout, stderr });
  return stdout.text();
}

function onlyRecord(rootDir: string, kind: "steps" | "scenarios"): Record<string, unknown> {
  const dir = path.join(rootDir, ".nukadoko", "records", kind);
  const ids = readdirSync(dir);
  return JSON.parse(readFileSync(path.join(dir, ids[0]!, "record.json"), "utf8"));
}

describe("schema_version", () => {
  let runProject: string;
  let exploreProject: string;
  const documents = new Map<DocumentKind, Record<string, unknown>>();

  beforeAll(async () => {
    runProject = await copyFixtureToTempDir("run-concurrency-project");
    exploreProject = await copyFixtureToTempDir("explore-relation-project");
    const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
    documents.set("check_report", parse(await cli(runProject, ["check", "--json", "features/basic/"])));
    documents.set("check_codes", parse(await cli(runProject, ["check", "--codes", "--json"])));
    documents.set("steps", parse(await cli(runProject, ["steps", "--json"])));
    documents.set("describe", parse(await cli(runProject, ["describe", "thing-exists"])));
    documents.set("tend_report", parse(await cli(runProject, ["tend", "--json"])));
    documents.set("tend_codes", parse(await cli(runProject, ["tend", "--codes", "--json"])));
    documents.set("refusal", parse(await cli(runProject, ["check", "--json", "features/nope.feature"])));
    documents.set("sessions", parse(await cli(runProject, ["session", "list", "--json"])));
    documents.set("step_record", parse(await cli(runProject, ["do", "thing-exists", "--args", '{"name":"widget"}'])));
    await cli(runProject, ["clean"]);
    const runStdout = await cli(runProject, ["run", "--records", "--no-check", "features/basic/a.feature"]);
    documents.set("scenario_record", parse(runStdout.trim().split("\n")[0]!));
    documents.set("run_result", parse(await cli(runProject, ["run", "--no-check", "--json", "features/basic/b.feature"])));
    documents.set("clean_plan", parse(await cli(runProject, ["clean", "--dry-run", "--json"])));
    documents.set(
      "explore_result",
      parse(await cli(exploreProject, ["experimental", "explore", "features/reverse.ts", "--seed", "1", "--runs", "20", "--length", "6", "--json"])),
    );
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(runProject);
    await removeTempDir(exploreProject);
  });

  it("covers every document kind", () => {
    expect([...documents.keys()].sort()).toEqual(Object.keys(SCHEMA_VERSIONS).sort());
  });

  it.each(Object.keys(SCHEMA_VERSIONS) as DocumentKind[])("%s starts with its schema_version", (kind) => {
    const document = documents.get(kind)!;
    expect(Object.keys(document)[0]).toBe("schema_version");
    expect(document.schema_version).toBe(1);
  });

  it("names the nukadoko version on the step record, the scenario record, and run.json", () => {
    const version = readOwnVersion();
    expect(documents.get("step_record")!.nukadoko).toBe(version);
    expect(documents.get("scenario_record")!.nukadoko).toBe(version);
    expect(documents.get("run_result")!.nukadoko).toBe(version);
    const onDisk = onlyRecord(runProject, "scenarios");
    expect([onDisk.schema_version, onDisk.nukadoko]).toEqual([1, version]);
  });

  it("puts schema_version first and keeps every key of the body", () =>
    hegel.test((tc) => {
      const kind = tc.draw(gs.sampledFrom(Object.keys(SCHEMA_VERSIONS) as DocumentKind[]));
      const keys = tc.draw(gs.arrays(gs.fromRegex("[a-z][a-z_]{0,8}"), { maxSize: 6, unique: true }));
      const body = Object.fromEntries(keys.filter((key) => key !== "schema_version").map((key, i) => [key, i]));
      const document = JSON.parse(JSON.stringify(versioned(kind, body)));
      expect(Object.keys(document)).toEqual(["schema_version", ...Object.keys(body)]);
      expect(document).toEqual({ schema_version: SCHEMA_VERSIONS[kind], ...body });
    }));
});
