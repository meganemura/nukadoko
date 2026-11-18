import { defineConfig } from "nukadoko";
import { writeFileSync } from "node:fs";

export default defineConfig({
  program: () => ({
    setup: (world) => writeFileSync("setup.txt", `set up ${world.name} ${world.tree}\n`),
    environments: {
      default: { version: () => "1.2.3" },
      remote: { url: (world) => `http://localhost:9/${world.name}` },
      failing: {
        setup: () => {
          throw new Error("no seed data");
        },
      },
      lost: {
        version: () => {
          throw new Error("no version endpoint");
        },
      },
    },
  }),
});
