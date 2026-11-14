import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Destructures only the user fixture loggedIn — never `page` itself.
// `needs_browser` must still read `true`:
// `loggedIn`'s own `page` dependency is what opens the browser.
export default defineStep({
  pattern: "logged in state is used",
  description: "Destructures loggedIn only — reaches page transitively",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ loggedIn }: any) {
    void loggedIn;
    return {};
  },
});
