// Two ways to read a JSON document that do not depend on the order its
// writer put keys in: the set of paths it holds with the type at each, and
// one value at a path, written with its keys sorted.

// Every leaf path, an array's items collapsed to [], with its JSON type;
// an empty object or array is a leaf of its own.
export function shape(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path} array`];
    return [...new Set(value.flatMap((item) => shape(item, `${path}[]`)))];
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return [`${path} object`];
    return keys.flatMap((key) => shape((value as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`));
  }
  return [`${path} ${value === null ? "null" : typeof value}`];
}

export function shapeText(value: unknown): string {
  return [...new Set(shape(value))].sort().join("\n");
}

// `a.b[2].c`: keys and array indexes.
export function at(value: unknown, path: string): unknown {
  let current = value;
  for (const [, key, index] of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== "object") return undefined;
    current = index === undefined ? (current as Record<string, unknown>)[key] : (current as unknown[])[Number(index)];
  }
  return current;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function canonical(value: unknown): string {
  return value === undefined ? "(nothing at this path)" : JSON.stringify(sorted(value), null, 2);
}
