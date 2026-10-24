import { defineConfig } from "./nukadoko-shim.js";

// Fixture for the Allure identity golden test (tests/report-allure-identity.test.ts):
// two environments (nukadoko.program.ts), so the environment is part of
// each result's identity, and a package.json name, so the project is part
// of every fullName.
export default defineConfig({});
