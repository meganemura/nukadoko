import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Opens one room's page, so the Then steps after it read what that page
// shows.
export default defineStep({
  pattern: "a person opens room {room:int}",
  description: "Open the page of one room",
  args: z.object({ room: z.number().describe("The number of the room") }),
  returns: z.object({}),
  mutates: false,
  async run({ page, baseURL }, { room }) {
    await page.goto(`${baseURL}/rooms/${room}`);
    return {};
  },
});
