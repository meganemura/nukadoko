import { defineConfig } from "./nukadoko-shim.js";

// tests/tend.test.ts's fixture: `nuka tend` must report zero notes and zero
// errors against it — every step has a bound pattern, every schema field is
// described, every step has a rationale, `from` is exercised for real, and
// there is no `parameterTypes` entry to go unused.
export default defineConfig({});
