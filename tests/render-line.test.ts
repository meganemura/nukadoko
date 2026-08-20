import { describe, expect, it } from "vitest";
import {
  renderAttachmentBlock,
  renderPatternLine,
  type DocStringAttachment,
} from "../src/harvest/render-line.js";

// Responsibility: the pattern-escape and docstring-escape paths
// tests/build-draft.test.ts's own end-to-end harvest coverage never reaches
// directly: a backslash escape mid-pattern, a trailing unpaired backslash,
// an unterminated capture, and a docstring content line that itself starts
// with `"""` once trimmed. Unit-level against renderPatternLine/
// renderAttachmentBlock directly, the same way this module's own header
// describes them: pure text rendering, no round trip involved.

describe("renderPatternLine: backslash escapes", () => {
  it('resolves a mid-pattern "\\X" escape to the literal character X', () => {
    const result = renderPatternLine(String.raw`literal \(paren\) and \/slash`, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("literal (paren) and /slash");
      expect(result.captures).toEqual([]);
    }
  });

  it("keeps a trailing, unpaired backslash as a literal character", () => {
    // The pattern's very last character is "\" with nothing after it: the
    // escape branch requires a next character to consume, so this one falls
    // through to being appended literally instead.
    const result = renderPatternLine("trailing\\", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("trailing\\");
    }
  });
});

describe("renderPatternLine: unterminated capture", () => {
  it("returns an error naming the pattern when a capture is never closed", () => {
    const result = renderPatternLine("an {unterminated capture", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("unterminated capture");
      expect(result.message).toContain("an {unterminated capture");
    }
  });
});

describe("renderPatternLine: a {string} capture given a non-string value", () => {
  it("still renders a quoted textual form via String(value), not a thrown error", () => {
    // A harvested arg can disagree with its own pattern's declared type (a
    // custom step could return anything under that key); this function's
    // only job is to render *something* coherent. build-draft.ts's round
    // trip is what judges whether the result is right.
    const result = renderPatternLine("{amount:string}", { amount: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('"42"');
    }
  });
});

describe("renderAttachmentBlock: docstring content colliding with the closing fence", () => {
  it('escapes a content line that, once trimmed, starts with """, and leaves other lines untouched', () => {
    const attachment: DocStringAttachment = {
      kind: "docstring",
      key: "body",
      value: 'plain line\n"""not a real close\nlast line',
    };

    const block = renderAttachmentBlock(attachment, "  ");

    expect(block).toEqual([
      '  """',
      "  plain line",
      '  \\"""not a real close',
      "  last line",
      '  """',
    ]);
  });
});
