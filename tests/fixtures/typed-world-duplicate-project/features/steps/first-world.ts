import { z } from "zod";
import { defineWorld } from "../../nukadoko-compat-shim.js";

// tests/compat-typed-world.test.ts: second-world.ts also calls defineWorld
// — two registrations, whether in one file or (as here) across two, always
// collide (DuplicateWorldDefinitionError, m2c-typed-world task spec, item
// 2: "2 回目はエラー").
defineWorld({ first: z.string().optional() });
