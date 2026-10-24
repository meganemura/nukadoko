import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fetchCommandFor, UNSHALLOW_COMMAND } from "../src/run/git-ref.js";

// Responsibility: the `git fetch` a `base-shallow` refusal prints as its
// `do:` line (src/run/git-ref.ts's `fetchCommandFor`). A server fetches a
// commit by its full hash only, so an abbreviated hash, or a name that is a
// revision expression rather than a ref, is told to fetch the history.

const hex = gs.sampledFrom([..."0123456789abcdef"]);

describe("fetchCommandFor", () => {
  it("fetches a full commit hash by itself, and unshallows for an abbreviated one", () =>
    hegel.test((tc) => {
      const full = tc.draw(gs.sampledFrom([40, 64]));
      const digits = tc.draw(gs.arrays(hex, { minSize: full, maxSize: full })).join("");
      expect(fetchCommandFor(digits)).toBe(`git fetch --no-tags --depth=1 origin ${digits}`);
      const length = tc.draw(gs.integers({ minValue: 7, maxValue: 39 }));
      expect(fetchCommandFor(digits.slice(0, length))).toBe(UNSHALLOW_COMMAND);
    }));

  it("fetches a branch, a remote-tracking name, and a full ref name under the same name", () => {
    expect(fetchCommandFor("main")).toBe("git fetch --no-tags --depth=1 origin main:refs/heads/main");
    expect(fetchCommandFor("origin/release/1.x")).toBe("git fetch --no-tags --depth=1 origin release/1.x:refs/remotes/origin/release/1.x");
    expect(fetchCommandFor("refs/heads/main")).toBe("git fetch --no-tags --depth=1 origin main:refs/heads/main");
    expect(fetchCommandFor("refs/remotes/upstream/main")).toBe("git fetch --no-tags --depth=1 upstream main:refs/remotes/upstream/main");
    expect(fetchCommandFor("refs/tags/v1.0")).toBe("git fetch --no-tags --depth=1 origin refs/tags/v1.0:refs/tags/v1.0");
    expect(fetchCommandFor("refs/pull/1/head")).toBe("git fetch --no-tags --depth=1 origin refs/pull/1/head:refs/pull/1/head");
  });

  it("unshallows for a revision expression, which names no ref to fetch", () => {
    for (const ref of ["main~2", "HEAD^", "v1.0^{commit}", "@{u}", "main..topic"]) {
      expect(fetchCommandFor(ref)).toBe(UNSHALLOW_COMMAND);
    }
  });
});
