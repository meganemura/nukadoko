import { defineConfig } from "./nukadoko-shim.js";

// Exists only to give `nuka check` a project to walk; the two step files
// under features/steps/ and features/cart.feature are what this fixture
// tests.
export default defineConfig({});
