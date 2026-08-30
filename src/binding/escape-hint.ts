// Responsibility: build the escaped variant of an already-name-stripped
// pattern (src/binding/pattern.ts's `strippedPattern`, equivalently a
// CucumberExpression's own `.source`) that powers `nuka check`'s
// undefined-step near-miss hint (src/check/feature-check.ts). This helper is
// never consulted by the real matching path. The adjacent quote hint gets
// literal boundaries from pattern.ts's canonical scan, which preserves that
// scan's matching outputs.
// docs/spec.md "Typed steps": bare `(` `)` mean optional text and bare `/`
// means alternation to cucumber-expressions, so prose that meant them
// literally has to escape them; this module answers "would escaping this
// pattern's reserved characters have matched?" for the diagnostic, nothing
// more. Escapes every *bare* `(` `)` `/` it finds outside a `{...}`
// parameter token and outside an already-escaped `\X` pair, reusing
// stripCaptureNames' own left-to-right walk so this module never needs to
// understand the rest of cucumber-expressions' syntax (optional groups,
// alternation) to find the `{...}` tokens correctly.

export function escapeReservedChars(strippedPattern: string): string {
  let result = "";
  let i = 0;
  while (i < strippedPattern.length) {
    const ch = strippedPattern[i];
    if (ch === "\\" && i + 1 < strippedPattern.length) {
      result += strippedPattern.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = strippedPattern.indexOf("}", i + 1);
      if (end === -1) {
        // Malformed input for this stage (an already-built CucumberExpression
        // can't have an unterminated `{`) — copy the rest verbatim rather
        // than throw; this module only ever informs an optional hint.
        result += strippedPattern.slice(i);
        break;
      }
      result += strippedPattern.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "/") {
      result += `\\${ch}`;
      i += 1;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}
