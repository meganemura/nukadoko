// Shared helper for step files under this fixture project. Deliberately not
// a step — no defineStep call, no brand — to exercise discovery's "skip a
// non-step default export silently" behavior (docs/spec.md: "Shared helpers
// live in ordinary modules e.g. features/steps/lib/").

export function formatId(prefix: string, seq: number): string {
  return `${prefix}_${String(seq).padStart(4, "0")}`;
}

const lib = { formatId };
export default lib;
