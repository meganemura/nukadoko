import { defineConfig } from "./nukadoko-shim.js";

// Fixture for the Allure identity golden test (tests/report-allure-identity.test.ts):
// two environments (the program's environments), so the environment is part of
// each result's identity, and a package.json name, so the project is part
// of every fullName.
// Programs nukadoko does not start: each environment's world is only a URL.

export default defineConfig({
  program: () => ({
    url: "http://default.example",
    environments: {
      staging: { url: "http://staging.example" },
      production: { url: "http://production.example" },
    },
  }),
});
