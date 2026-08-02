import { z } from "zod";
import { defineWorld } from "../../nukadoko-compat-shim.js";

// See first-world.ts: this second defineWorld() call is the duplicate.
defineWorld({ second: z.string().optional() });
