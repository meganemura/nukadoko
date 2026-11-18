import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, defineFixtures } from "nukadoko";

export default defineConfig({
  fixtures: defineFixtures({
    tenant: async ({}, use) => {
      const tenant = mkdtempSync(path.join(tmpdir(), "tenant"));
      const outcome = await use(tenant); // "passed" | "failed"
      appendFileSync("outcomes.txt", `${outcome}\n`);
      if (outcome === "passed") rmSync(tenant, { recursive: true });
      if (outcome === "failed") throw new Error("kept the tenant\nfor a look");
    },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    tenant: string;
  }
}
