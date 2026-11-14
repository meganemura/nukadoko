import { defineConfig } from "./nukadoko-shim.js";

// The walk tests (tests/run-step.test.ts) run one scenario here with
// nuka run --step and answer each pause with nuka step. The cart page
// is set with setContent and needs no server; the polling page needs the
// program the test writes.
export default defineConfig({});
