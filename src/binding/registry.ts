import { ParameterTypeRegistry } from "@cucumber/cucumber-expressions";

// Responsibility: the one ParameterTypeRegistry `nuka check` and (later)
// `nuka run` share. `new ParameterTypeRegistry()` already registers
// cucumber-expressions' own built-in types (int, float, word, string, the
// anonymous type, ...) in its constructor, so this factory's only job today
// is to be the single named place that decision lives — a project has no
// way to register a custom parameter type yet (this task's spec: "custom
// parameter type の登録 API は未設計"). An unknown type name in a pattern
// therefore surfaces as cucumber-expressions' own UndefinedParameterTypeError
// when the expression is built; src/check/binding-check.ts reports that
// error as-is rather than this module swallowing or replacing it.
export function createParameterTypeRegistry(): ParameterTypeRegistry {
  return new ParameterTypeRegistry();
}
