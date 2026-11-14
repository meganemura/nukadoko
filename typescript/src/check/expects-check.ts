import { EXPECTED_KIND_ORDER, EXPECTED_KINDS, EXPECTS_PREFIX, isExpectedKind } from "../condition/condition.js";
import type { LoadedProgram } from "../config/load-program.js";
import { worldsToStart } from "../environment/resolve-environment.js";
import type { ExpectsTagOccurrence } from "../feature/load-features.js";
import { namesPlaceholder } from "../program/placeholders.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `nuka check` findings about `@expects:` tags
// (docs/spec.md "Failures underneath") that can only end one way.
// `expects-tag-malformed`: a tag that does not read accepts nothing.
// `expects-unread`: an `@expects:error=` tag where no world the run would
// start reads execution events, so it can never match. Boundary: pure;
// reading the files and the program is src/check/analyze.ts's.
//
// Silent on what only the run can say: a page-error tag on a scenario that
// may never open a page, a status no route answers, a class the program
// never raises. The run's `expects-unseen` note is the measured answer.
//
// `expects-unread` is a warning, not an error: the tag is inert, not
// wrong, and a later run with another `--env` may read events. It is
// judged for the worlds a `nuka run` with the same `--env` flags would
// start, as `events-unread` is (src/check/events-check.ts).

export interface ExpectsCheckInput {
  readonly expectsTags: readonly ExpectsTagOccurrence[];
  readonly program: LoadedProgram | null;
  readonly envs: readonly string[];
  readonly programFile: string;
}

const FORMS = EXPECTED_KIND_ORDER.map((kind) => `${EXPECTS_PREFIX}${kind}=${EXPECTED_KINDS[kind].placeholder}`);
const FORMS_TEXT = `${FORMS.slice(0, -1).join(", ")}, or ${FORMS.at(-1)}`;

/** Why `tag`, an `@expects:` tag that does not read, accepts nothing. */
function whyMalformed(tag: string): string {
  const body = tag.slice(EXPECTS_PREFIX.length);
  const equals = body.indexOf("=");
  const kind = equals === -1 ? body : body.slice(0, equals);
  if (!isExpectedKind(kind)) return `${tag} does not read as ${FORMS_TEXT}, so it accepts nothing`;
  const words = EXPECTED_KINDS[kind].words;
  if (equals === -1 || equals === body.length - 1) return `${tag} names no value, and an @expects tag names what it accepts: ${words}`;
  return `${tag} does not name ${words}, so it accepts nothing${kind === "status" ? ": a run judges no other status, and one tag names one status" : ""}`;
}

export function checkExpects(input: ExpectsCheckInput): { readonly errors: CheckIssue[]; readonly warnings: CheckIssue[] } {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  for (const occurrence of input.expectsTags) {
    if (occurrence.read !== undefined) continue;
    errors.push({ code: "expects-tag-malformed", message: whyMalformed(occurrence.tag), file: occurrence.relativePath, line: occurrence.line });
  }
  const errorTags = input.expectsTags.filter((occurrence) => occurrence.read?.kind === "error");
  if (errorTags.length === 0) return { errors, warnings };
  const unread = whyEventsUnread(input);
  if (unread === undefined) return { errors, warnings };
  for (const occurrence of errorTags) {
    warnings.push({
      code: "expects-unread",
      message: `${occurrence.tag} accepts an unhandled error the program reports in its execution events, and no world this run starts reads them (${unread}), so the tag can never match`,
      file: occurrence.relativePath,
      line: occurrence.line,
    });
  }
  return { errors, warnings };
}

// Why no world the run would start reads execution events, or `undefined`
// when one does.
function whyEventsUnread(input: ExpectsCheckInput): string | undefined {
  if (input.program === null) return `the project has no ${input.programFile}, so no world starts`;
  const reasons: string[] = [];
  for (const world of worldsToStart(input.program.program, input.envs)) {
    const { reach } = world.recipe;
    if (reach.kind === "serve" && namesPlaceholder(world.recipe, "events")) return undefined;
    reasons.push(
      `world ${world.name}: ${
        reach.kind === "serve" ? "the program file names no {events}" : reach.kind === "url" ? "the program runs at a url, which nukadoko does not start" : "it has neither serve nor url"
      }`,
    );
  }
  return reasons.length === 0 ? "the run starts no world" : reasons.join("; ");
}
