import { defineStep, z } from "../../nukadoko-shim.js";
import tryToOpenSettings from "./try-to-open-settings.js";

export default defineStep({
  pattern: "the browser is on the {page:word} page",
  args: z.object({ page: z.string(), landedOn: z.string() }),
  from: { landedOn: [tryToOpenSettings, "page"] },
  claims: [{ actual: "landedOn", compare: "equal", expected: "page" }],
});
