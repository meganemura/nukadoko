import { z } from "zod";
import { defineWorld } from "../../nukadoko-compat-shim.js";

// A reserved cucumber-js World field cannot be declared through defineWorld
// (ReservedWorldKeyDeclaredError) — proto-typed-world/findings.md Q5.
defineWorld({ attach: z.any() });
