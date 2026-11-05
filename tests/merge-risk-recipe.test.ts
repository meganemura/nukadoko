import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: skills/nukadoko/scripts/merge-risk.jq, which
// references/merge-risk.md tells an agent to run, read against a real
// run.json of `nuka run --base`. The change under it holds one of each
// shape the five answers name: a difference INTENT.md declares, a write
// nothing declares, an error caught and passed over, and a new criterion
// whose route deletes payments and answers 500. A rename in run.json that
// the script still reads by its old name turns an answer into "none"
// without any error, so the whole output is compared.

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });

const PROGRAM = `import { defineProgram } from "./nukadoko-shim.js";
export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/up" },
  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", JOBS_DIR: "{dir}/jobs" },
});
`;
const BASE_FEATURE = `Feature: Rooms and scores

  Scenario: a room page reads the room
    When the client gets "/rooms/7"

  @scores
  Scenario: a score is placed
    When the client posts to "/scores"
    Then the score row was inserted once
`;
const HEAD_FEATURE = BASE_FEATURE + `
  @refunds
  Scenario: a refund is placed
    When the client posts to "/refunds"
`;
const ROOM = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "rooms", op: "read", rows: 1 });\n`;
const SCORE = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, ids: [42], committed: true });\n`;
const decided = (tier: string) => `    emit({ trace, kind: "x_decision", id: newId(), parent: id, x_id: newId(), x_subject: { room: 7 }, x_result: { tier: ${JSON.stringify(tier)}, seats: 4 } });\n`;
const REFUND_ANCHOR = `  } else if (url.pathname === "/greeting") {\n`;
const REFUND = `  } else if (url.pathname === "/refunds") {
    status = 500;
    emit({ trace, kind: "db", id: newId(), parent: id, table: "payments", op: "delete", rows: 3, committed: true });
    emit({ trace, kind: "error", id: newId(), parent: id, class: "RefundGatewayTimeout", handled: false });
`;
const AUDIT = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "audit_log", op: "insert", rows: 1, committed: true });\n`;
const SWALLOWED = `    emit({ trace, kind: "error", id: newId(), parent: id, class: "AuditWriteFailed", handled: true });\n`;
const INTENT = `# Intent

Room 7 becomes a gold room. Refunds can be placed.

| Target | Observation | Before | After |
| --- | --- | --- | --- |
| x_subject.room=7 | x_decision x_result.tier | basic | gold |
`;

const SCRIPT = path.join(repoRoot, "skills", "nukadoko", "scripts", "merge-risk.jq");
const answer = (runJson: string, ...args: string[]): string => execFileSync("jq", ["-r", ...args, "-f", SCRIPT, runJson], { encoding: "utf8" });

describe("merge-risk.jq on a run against the base", () => {
  let rootDir: string;
  let runJson: string;

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(path.resolve("src/index.js"))};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    writeFileSync(path.join(rootDir, "features", "events.feature"), BASE_FEATURE);
    const server = path.join(rootDir, "app", "server.mjs");
    const source = readFileSync(server, "utf8");
    for (const anchor of [ROOM, SCORE, REFUND_ANCHOR]) expect(source.split(anchor)).toHaveLength(2);
    writeFileSync(server, source.replace(ROOM, ROOM + decided("basic")));
    git(rootDir, "init", "-q", "-b", "main");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "base");
    git(rootDir, "branch", "base-branch");
    writeFileSync(path.join(rootDir, "INTENT.md"), INTENT);
    writeFileSync(path.join(rootDir, "features", "events.feature"), HEAD_FEATURE);
    writeFileSync(
      server,
      source
        .replace(ROOM, ROOM + decided("gold"))
        .replace(SCORE, SCORE + AUDIT + SWALLOWED)
        .replace(REFUND_ANCHOR, REFUND + REFUND_ANCHOR),
    );
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "Make room 7 gold and take refunds");
    await runCli(["run", "--base", "base-branch"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    runJson = path.join(latestRunDir(rootDir), "run.json");
  }, 240_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("answers the five questions with what the run measured", () => {
    expect(answer(runJson, "--argjson", "sensitive", '["payments"]')).toBe(
      [
        "## Verification",
        "- features/events.feature:3 a room page reads the room: held",
        "- features/events.feature:7 a score is placed: held",
        "- features/events.feature:12 a refund is placed: failed",
        "- features/events.feature:3 judges no claim on a Then, so its verdict proves no outcome",
        "",
        "## Alignment",
        "- INTENT.md row 1 (x_subject.room=7 | x_decision x_result.tier | basic -> gold): as_intended",
        '- declared nowhere, at features/events.feature:7: {"kind":"db","table":"audit_log","op":"insert"}, {"kind":"error","class":"AuditWriteFailed","handled":true}',
        "",
        "## Impact",
        "- tables touched differently at head: audit_log insert, payments delete",
        "- routes answered differently at head: POST /refunds",
        "- sensitive: payments delete at features/events.feature:12",
        "",
        "## Rollback cost",
        "- deletes and updates new at head: payments delete at features/events.feature:12",
        "- not measured: schema changes, backfills, and effects outside the program's execution events",
        "",
        "## Error detection",
        "- unexpected failure at features/events.feature:13",
        "- unhandled errors new at head: RefundGatewayTimeout at features/events.feature:12",
        "- errors caught and passed over, new at head (whether each reached monitoring is not measured): AuditWriteFailed at features/events.feature:7",
        "",
      ].join("\n"),
    );
  });

  it("says when no sensitive list was given, and when one matched nothing", () => {
    expect(answer(runJson).split("\n")).toContain("- sensitive: no list given");
    expect(answer(runJson, "--argjson", "sensitive", '["auth_tokens"]').split("\n")).toContain("- sensitive: none of the listed tables or routes");
  });

  it("stops on a run with no base, since every answer but one is a difference from it", () => {
    const noBase = path.join(rootDir, "no-base.json");
    const document = JSON.parse(readFileSync(runJson, "utf8"));
    writeFileSync(noBase, JSON.stringify({ ...document, paths: [] }));
    expect(answer(noBase)).toBe("This run has no paths against a base. Run `nuka run --base <ref>` and read its run.json.\n");
  });
});
