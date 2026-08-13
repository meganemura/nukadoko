import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// This fixture's own step vocabulary, distinct from any WebMCP tool a page
// under test might declare (see webmcp-experimental.test.ts): the second
// test in that file needs `nuka steps --json` to actually return something,
// so a vocabulary that came back empty either way could not tell "the
// WebMCP tool leaked in" apart from "there was nothing to check".
export default defineStep({
  pattern: "the fixture project has its own step vocabulary",
  description: "A trivial step that exists only so nuka steps has something of its own to report",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
