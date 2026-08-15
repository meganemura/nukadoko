import { z } from "zod";
import { defineWorld } from "../../nukadoko-compat-shim.js";

// tests/compat-typed-world.test.ts: second-world.ts also calls defineWorld
// — two registrations, whether in one file or (as here) across two, always
// collide (DuplicateWorldDefinitionError; the second call is an error).
defineWorld({ first: z.string().optional() });
