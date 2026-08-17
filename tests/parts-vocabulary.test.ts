import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `parts` end to end against `nuka steps --json` and
// `nuka describe` (docs/spec.md "Parts": "`parts` survives into `nuka
// steps --json` and `nuka describe`, so an agent reading the vocabulary
// sees that one step is built out of two others without opening a file").
// Reuses tests/fixtures/parts-project (already built for tests/parts.test.ts's
// own `call`/`parts` execution coverage) rather than a second fixture: this
// file never executes a step, so the fixture's own baseURL placeholder is
// never touched.

describe('nuka steps --json / nuka describe: parts (docs/spec.md "Parts")', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("parts-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("shows parts as an array of vocabulary names, one level of the chain at a time", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: Array<{ name: string; parts?: string[] }> };

    const projectWithMember = report.steps.find((s) => s.name === "project-with-member");
    expect(projectWithMember?.parts).toEqual(["invite-member"]);

    // invite-member itself declares send-invite as its own part — this
    // field names only the step's own direct parts, never the whole chain
    // flattened.
    const inviteMember = report.steps.find((s) => s.name === "invite-member");
    expect(inviteMember?.parts).toEqual(["send-invite"]);
  });

  it("omits parts entirely for a step that declares none (same convention `from` already follows)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: Array<{ name: string; parts?: string[] }> };

    const plainStep = report.steps.find((s) => s.name === "plain-step");
    expect(plainStep).toBeDefined();
    expect(plainStep).not.toHaveProperty("parts");
  });

  it("nuka steps (non-JSON) never grows a second line for parts", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    // One block per step, blank-line separated (formatVocabulary's own
    // shape) — "invite-member" itself never appears a second time as a
    // parts listing under project-with-member's own block.
    const blocks = stdout.text().trim().split("\n\n");
    const projectWithMemberBlock = blocks.find((b) => b.startsWith("project-with-member"))!;
    expect(projectWithMemberBlock).toBeDefined();
    expect(projectWithMemberBlock).not.toContain("parts");
  });

  it("nuka describe shows each part's own name and description", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["describe", "project-with-member"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract.parts).toEqual([
      {
        name: "invite-member",
        description: "Invite a member: POST to the server, then call send-invite, a part of its own",
      },
    ]);
  });

  it("nuka describe omits parts entirely for a step that declares none", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["describe", "plain-step"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract).not.toHaveProperty("parts");
  });

  it("nuka describe never lists the reverse (which steps call this one as a part)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["describe", "send-invite"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    // send-invite is itself a part of invite-member, but describe looks at
    // one step's own contract only (this module's own header) — it never
    // shows "used as a part by: invite-member".
    expect(contract).not.toHaveProperty("parts");
  });
});
