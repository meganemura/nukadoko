import { z } from "zod";
import { Given, defineWorld } from "../../nukadoko-compat-shim.js";

// The test overwrites this file for `page` and for `request`. The committed
// copy is the request form so the fixture is a complete project on its own.
defineWorld({ request: z.string().optional() });

Given("the world is ready", async function () {
  // The body is never the point: registration of the getter is.
});
