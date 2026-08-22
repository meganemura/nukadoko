import { describe, expect, it } from "vitest";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`/`steps`/`describe` collect an unreadable
// step file into `importFailures` and explain it there. `nuka run` and
// `nuka do` never reach that list: discovery is fail-fast for them, so the
// error itself is all the reader gets, and those two are the commands a
// project is most likely to type first. Node's own message for a CommonJS
// project's .ts step names a path the file plainly occupies, which reads
// as "the file is missing" rather than "this project reads .ts as
// CommonJS", so the explanation has to travel on the throw as well.
describe("discoverSteps: fail-fast import failure in a CommonJS project", () => {
  it("carries the CJS/.ts explanation on the thrown error", async () => {
    const rootDir = fixture("check-import-failure-cjs-project");

    await expect(discoverSteps(rootDir, "features")).rejects.toThrow(
      /This project has no "type": "module" in package\.json/,
    );
  });

  it("keeps the original failure as the thrown error's own cause", async () => {
    const rootDir = fixture("check-import-failure-cjs-project");

    const error = await discoverSteps(rootDir, "features").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Cannot find module");
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});
