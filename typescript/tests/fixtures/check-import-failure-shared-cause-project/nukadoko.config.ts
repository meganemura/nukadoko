import { defineConfig } from "./nukadoko-shim.js";

// Two step files that both
// import the same broken shared module, so both fail with the identical
// error message Node's ESM loader caches and rethrows to every importer.
// This project exists only to prove `nuka check`'s human formatter groups
// those two failures under one printed message instead of repeating it, and
// keeps a third, differently-broken file to prove a distinct message still
// gets its own group.
export default defineConfig({});
