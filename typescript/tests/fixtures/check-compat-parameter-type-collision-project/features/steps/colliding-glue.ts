import { defineParameterType } from "../../nukadoko-compat-shim.js";

// Collides with cucumber-expressions' own built-in "int" type — tests/check
// -compat.test.ts asserts this reuses the existing `parameter-type-invalid`
// issue: a name collision reuses the existing error, the same code a
// config.parameterTypes collision already produces.
defineParameterType({ name: "int", regexp: /[0-9]+/ });
