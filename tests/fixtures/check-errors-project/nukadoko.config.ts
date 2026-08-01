import { defineConfig } from "./nukadoko-shim.js";

// Deliberately packs one occurrence of every `nuka check` error category
// into a single project (m1-check task spec, scope item 2: "上記エラー...
// が検出される、それぞれ最低1ケース") — see each step file under
// features/steps/ and features/check.feature and features/broken.feature
// for which category each piece triggers.
export default defineConfig({});
