// Responsibility: the KEY=VALUE parser both `ctx.env` (src/context/env.ts)
// and the secret set (src/secrets/build-secret-set.ts) share. It lives in
// its own module so secrets can reuse the format without importing the
// context module: context already depends on secrets, and the reverse edge
// was only this function.

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    let value = withoutExport.slice(eq + 1).trim();
    const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
