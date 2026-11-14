import { z } from "zod";
import { defineWorld } from "../../nukadoko-compat-shim.js";

// A reserved cucumber-js World field cannot be declared through defineWorld
// (ReservedWorldKeyDeclaredError).
defineWorld({ attach: z.any() });
