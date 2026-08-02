import { defineParameterType } from "../../nukadoko-compat-shim.js";

// Collides with cucumber-expressions' own built-in "int" type — tests/check
// -compat.test.ts asserts this reuses the existing `parameter-type-invalid`
// issue (parameter-types-design.md "gradual compat" section, point 2: "名
// 前衝突は既存エラー"), the same code a config.parameterTypes collision
// already produces.
defineParameterType({ name: "int", regexp: /[0-9]+/ });
