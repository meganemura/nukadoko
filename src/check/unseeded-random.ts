// Responsibility: name the direct calls to Math.random and crypto.random*
// in one function's source text. It reads the text only; it never calls
// the function. Its boundary is the source string: a call reached through
// an import, a helper, or an alias is out of reach, and it says nothing
// about one. A name that the text also uses in a way other than a member
// call (a parameter, a local, a value passed along) could be a shadowing
// binding, so that name reports nothing: a check that guesses teaches
// people to ignore the ones that are right.

const CALL =
  /(?<![\w$.]\s*)(?:globalThis\s*\.\s*)?(Math|crypto)\s*\.\s*(random[\w$]*)\s*\(/g;

function bareUse(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.]\\s*)${name}(?![\\w$])(?!\\s*\\.)`).test(code);
}

/** The calls in the order they appear, each written as `Math.random()`. */
export function unseededRandomCalls(source: string): string[] {
  const code = codeOnly(source);
  const found: string[] = [];
  for (const match of code.matchAll(CALL)) {
    const [, object, member] = match;
    if (object === "Math" && member !== "random") continue;
    if (bareUse(code, object!)) continue;
    found.push(`${object}.${member}()`);
  }
  return found;
}

// A `/` after one of these starts a regular expression, not a division.
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * The source with every comment, string, regular expression, and template
 * text replaced by a space. A template's `${}` parts are code, so they stay.
 */
export function codeOnly(source: string): string {
  let out = "";
  let index = 0;
  // Each entry is the brace depth inside one open `${`.
  const templates: number[] = [];
  let lastSignificant = "";
  const length = source.length;

  const skipTemplateText = (): void => {
    while (index < length) {
      const char = source[index]!;
      if (char === "\\") {
        index += 2;
      } else if (char === "`") {
        index += 1;
        out += " ";
        lastSignificant = "x";
        return;
      } else if (char === "$" && source[index + 1] === "{") {
        index += 2;
        templates.push(0);
        out += " ";
        lastSignificant = "{";
        return;
      } else {
        index += 1;
      }
    }
  };

  while (index < length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      out += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      out += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < length && source[index] !== char) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      out += " ";
      lastSignificant = "x";
      continue;
    }
    if (char === "`") {
      index += 1;
      skipTemplateText();
      continue;
    }
    if (char === "/" && (lastSignificant === "" || REGEX_AFTER.has(lastSignificant) || REGEX_AFTER_WORD.test(out.trimEnd()))) {
      index += 1;
      let inClass = false;
      while (index < length) {
        const current = source[index]!;
        if (current === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        else if (current === "\n") break;
      }
      while (index < length && /[a-z]/i.test(source[index]!)) index += 1;
      out += " ";
      lastSignificant = "x";
      continue;
    }
    if (templates.length > 0) {
      if (char === "{") {
        templates[templates.length - 1]! += 1;
      } else if (char === "}") {
        if (templates[templates.length - 1] === 0) {
          templates.pop();
          index += 1;
          out += " ";
          skipTemplateText();
          continue;
        }
        templates[templates.length - 1]! -= 1;
      }
    }
    out += char;
    index += 1;
    if (!/\s/.test(char)) lastSignificant = /[\w$]/.test(char) ? "x" : char;
  }
  return out;
}
