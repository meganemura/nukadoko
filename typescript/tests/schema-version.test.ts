import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { SCHEMA_VERSIONS, versioned, type DocumentKind } from "../src/record/schema-version.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: every document kind in SCHEMA_VERSIONS, produced the way a
// user produces it, starts with its own `schema_version`, and the records
// run.json, which is the `nuka run --json` envelope, also name the nukadoko
// version that wrote them.

async function cli(rootDir: string, argv: string[]): Promise<string> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  await runCli(argv, { rootDir, stdout, stderr });
  return stdout.text();
}

// Every command's `--json` is one envelope with its own version; the
// records keep a version per kind.
const ENVELOPE_KEYS = ["schema_version", "nukadoko", "command", "verdict", "findings"];

describe("schema_version", () => {
  let runProject: string;
  const documents = new Map<DocumentKind, Record<string, unknown>>();
  const envelopes = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    runProject = await copyFixtureToTempDir("run-concurrency-project");
    const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
    envelopes.set("check", parse(await cli(runProject, ["check", "--json", "features/basic/"])));
    envelopes.set("check --codes", parse(await cli(runProject, ["check", "--codes", "--json"])));
    envelopes.set("steps", parse(await cli(runProject, ["steps", "--json"])));
    envelopes.set("describe", parse(await cli(runProject, ["describe", "thing-exists"])));
    envelopes.set("refused", parse(await cli(runProject, ["check", "--json", "features/nope.feature"])));
    envelopes.set("removed", parse(await cli(runProject, ["session", "list", "--json"])));
    documents.set("step_record", parse(await cli(runProject, ["do", "thing-exists", "--args", '{"name":"widget"}'])));
    await cli(runProject, ["clean"]);
    envelopes.set("run", parse(await cli(runProject, ["run", "--no-check", "--json", "features/basic/b.feature"])));
    const runId = envelopes.get("run")!.run_id as string;
    const runDir = path.join(runProject, ".nukadoko", "runs");
    envelopes.set("run.json", parse(readFileSync(path.join(runDir, runId, "run.json"), "utf8")));
    documents.set("run_sources", parse(readFileSync(path.join(runDir, runId, "sources.json"), "utf8")));
    envelopes.set("report", parse(await cli(runProject, ["report", "--format", "allure", "--json"])));
    envelopes.set("clean", parse(await cli(runProject, ["clean", "--dry-run", "--json"])));
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(runProject);
  });

  it("covers every record kind", () => {
    expect([...documents.keys()].sort()).toEqual(Object.keys(SCHEMA_VERSIONS).sort());
  });

  it.each(Object.keys(SCHEMA_VERSIONS) as DocumentKind[])("%s starts with its schema_version", (kind) => {
    const document = documents.get(kind)!;
    expect(Object.keys(document)[0]).toBe("schema_version");
    expect(document.schema_version).toBe(SCHEMA_VERSIONS[kind]);
  });

  it.each([
    ["check", "check", "passed"],
    ["check --codes", "check", "passed"],
    ["steps", "steps", "passed"],
    ["describe", "describe", "passed"],
    ["refused", "check", "refused"],
    ["removed", "session", "refused"],
    ["run", "run", "passed"],
    ["run.json", "run", "passed"],
    ["report", "report", "passed"],
    ["clean", "clean", "passed"],
  ])("nuka %s --json prints the envelope first", (name, command, verdict) => {
    const document = envelopes.get(name)!;
    expect(Object.keys(document).slice(0, 5)).toEqual(ENVELOPE_KEYS);
    expect(document).toMatchObject({ schema_version: 4, nukadoko: readOwnVersion(), command, verdict });
    expect(Array.isArray(document.findings)).toBe(true);
  });

  it("names the nukadoko version on the step record and run.json, which is the run's --json document", () => {
    const version = readOwnVersion();
    expect(documents.get("step_record")!.nukadoko).toBe(version);
    expect(envelopes.get("run.json")!.nukadoko).toBe(version);
    expect(envelopes.get("run.json")).toEqual(envelopes.get("run"));
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
