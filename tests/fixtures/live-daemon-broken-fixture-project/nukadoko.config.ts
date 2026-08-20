import { defineConfig } from "./nukadoko-shim.js";

// A fixture definition destructuring a name that is not a known fixture:
// `validateFixtureDefinitions` catches this once, at config load, and
// every request this session could ever serve would fail the exact same
// way, so createSessionCore refuses to come up at all rather than opening
// a socket that can only ever reject.
export default defineConfig({
  stateDir: "s",
  fixtures: {
    broken: [
      async ({ notAFixture }: any, use: any) => {
        await use(1);
      },
      { scope: "process" },
    ],
  },
});
