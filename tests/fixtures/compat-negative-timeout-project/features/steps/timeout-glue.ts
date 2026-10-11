import { Given } from "../../nukadoko-compat-shim.js";

// setDefaultTimeout(-1) is registered in ../support/set-default-timeout.ts.
// A step with no `{ timeout }` of its own must finish. A step that declares
// a positive `{ timeout }` must still be cut off at that value.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Long enough that a timer armed for -1ms (which Node fires on the next
// turn) fails this step, and short enough that a real wait is cheap.
Given("a legacy step under a negative default timeout sleeps briefly", async function () {
  await sleep(80);
});

// Own `{ timeout: -1 }` is the same idiom as setDefaultTimeout(-1), on one
// step. It must not fall through to a timer.
Given(
  "a legacy step whose own timeout is negative sleeps briefly",
  { timeout: -1 },
  async function () {
    await sleep(80);
  },
);

// Own positive timeout wins over the negative default. 30ms is far under
// the 400ms sleep, so a run that honors the option fails here, and a run
// that treated every timeout as off would wait out the sleep.
Given(
  "a legacy step whose own timeout is short sleeps too long",
  { timeout: 30 },
  async function () {
    await sleep(400);
  },
);
