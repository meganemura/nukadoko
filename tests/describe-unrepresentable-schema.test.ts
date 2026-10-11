import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka describe` on a step whose args or returns schema
// JSON Schema cannot represent. Zod throws ("Transforms cannot be
// represented in JSON Schema", "Date cannot be represented in JSON
// Schema"), and the command's catch used to print only that message and
// write no contract. The step name, and every other field, disappeared.
// The contract has to come out anyway, with the failed side null and an
// error that names the step, and the command exits 1 the way an unreadable
// `from` already does. A sibling whose schema can be represented still
// describes, including while those other steps sit in the same vocabulary.

const PROJECT = fixture("unrepresentable-schema-project");

interface Described {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly contract: {
    readonly name?: string;
    readonly description?: string;
    readonly args?: unknown;
    readonly returns?: unknown;
    readonly args_error?: string;
    readonly returns_error?: string;
  };
}

async function describeStep(name: string): Promise<Described> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["describe", name], { rootDir: PROJECT, stdout, stderr });
  const text = stdout.text();
  return {
    exitCode,
    stdout: text,
    stderr: stderr.text(),
    contract: text === "" ? {} : (JSON.parse(text) as Described["contract"]),
  };
}

describe("nuka describe: a schema JSON Schema cannot represent", () => {
  it("names the step when args cannot be represented, and still prints the rest of the contract", async () => {
    const described = await describeStep("trim");

    expect(described.exitCode).toBe(1);
    expect(described.stderr).toBe("");
    expect(described.contract.name).toBe("trim");
    expect(described.contract.description).toBe("Trim a name");
    expect(described.contract.args).toBeNull();
    expect(described.contract.args_error).toContain("trim");
    expect(described.contract.args_error).toContain("Transforms cannot be represented in JSON Schema");
    expect(described.contract.returns).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(described.contract.returns_error).toBeUndefined();
  });

  it("names the step when returns cannot be represented, and still prints args", async () => {
    const described = await describeStep("moment");

    expect(described.exitCode).toBe(1);
    expect(described.stderr).toBe("");
    expect(described.contract.name).toBe("moment");
    expect(described.contract.description).toBe("Name a moment");
    expect(described.contract.args).toMatchObject({
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    });
    expect(described.contract.args_error).toBeUndefined();
    expect(described.contract.returns).toBeNull();
    expect(described.contract.returns_error).toContain("moment");
    expect(described.contract.returns_error).toContain("Date cannot be represented in JSON Schema");
  });

  it("still describes a representable schema in the same vocabulary", async () => {
    const described = await describeStep("echo");

    expect(described.exitCode).toBe(0);
    expect(described.stderr).toBe("");
    expect(described.contract.name).toBe("echo");
    expect(described.contract.description).toBe("Echo a name");
    expect(described.contract.args).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(described.contract.returns).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(described.contract.args_error).toBeUndefined();
    expect(described.contract.returns_error).toBeUndefined();
  });
});
