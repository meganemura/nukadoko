// Responsibility: fill the placeholders a program file writes in its
// commands and its env (docs/spec.md "Program"). Pure: values in, text
// out. Boundary: which values a world has is src/program/world.ts's.
//
// Only the six names below are placeholders. Any other text in braces is
// left as written, so a command that passes JSON or a shell brace needs no
// escape. A placeholder this world has no value for (`{port}` in a world
// that does not serve, anything but `{root}` in a build command) is
// refused by name instead of becoming an empty string, which would start
// a server on no port or point a database at no directory.

export const PLACEHOLDER_NAMES = ["port", "url", "dir", "root", "world", "token"] as const;

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

export type PlaceholderValues = Readonly<Partial<Record<PlaceholderName, string>>>;

const PLACEHOLDER = new RegExp(`\\{(${PLACEHOLDER_NAMES.join("|")})\\}`, "g");

/** `text` with each placeholder replaced by its value, or the first
 * placeholder `values` has none for. */
export function fillPlaceholders(text: string, values: PlaceholderValues): { readonly text: string } | { readonly missing: PlaceholderName } {
  let missing: PlaceholderName | undefined;
  const filled = text.replace(PLACEHOLDER, (whole, name: PlaceholderName) => {
    const value = values[name];
    if (value === undefined) {
      missing ??= name;
      return whole;
    }
    return value;
  });
  return missing === undefined ? { text: filled } : { missing };
}
