import {
  AttachmentContentEncoding,
  IdGenerator,
  SourceMediaType,
  TimeConversion,
  version as protocolVersion,
  type Envelope,
  type GherkinDocument,
  type Meta,
  type Pickle,
} from "@cucumber/messages";
import path from "node:path";
import type { ScenarioRecord } from "../../record/scenario-record.js";
import type { StepRecord } from "../../record/types.js";
import { mapScenario, type MessagesAttachmentPlan } from "./map-scenario.js";

// Responsibility: one run as a cucumber-messages stream, for
// `nuka report --format messages`: the I/O half of this directory, the
// part that reads each declared file attachment's bytes to base64-encode
// and owns the one `IdGenerator.uuid()` instance every id in the stream
// comes from. map-scenario.ts stays pure (its own header explains why).
// The caller decides where each envelope line goes, a file or stdout.
//
// Why this stream exists at all: unlike Allure (nukadoko's own measurement
// surface), it is compat fidelity only, so a migrated team's existing
// formatter, JUnit step, or HTML report keeps working. step record
// internals (validated result, observed, mutates, error.kind) never appear
// here: `TestStepResult` and `TestStepFinished` are
// `additionalProperties: false` closed schemas with no place to put them,
// and nothing here smuggles them in. The stream stays exactly what
// cucumber-messages defines.
//
// Rendered after the run, from what the run kept: the feature text it
// parsed (sources.json), its scenario records, and its step records. Both
// timestamps of the run are run.json's, and `meta` names the nukadoko
// version that ran it, so rendering the same run twice gives the same
// stream apart from its ids. `testRunFinished.success` is the run's verdict,
// which already absorbed every BeforeAll and AfterAll failure, the one
// place a run-scope hook's failure shows, since neither hook has a record
// of its own.
//
// A file attachment that cannot be read is dropped with a warning, and a
// scenario that fails to map is left out with a warning; the rest of the
// stream continues either way.

export interface MessagesFeatureInput {
  readonly relativeFeaturePath: string;
  readonly gherkinDocument: GherkinDocument;
  /** Every pickle the run selected from this file. */
  readonly pickles: readonly Pickle[];
  readonly source: string;
}

export interface MessagesScenarioInput {
  readonly record: ScenarioRecord;
  readonly pickle: Pickle;
  readonly stepRecords: ReadonlyMap<string, StepRecord | null>;
}

export interface MessagesStreamOptions {
  /** One NDJSON line, newline included. */
  readonly write: (line: string) => void;
  /** Where a path a record names is on disk. */
  readonly resolvePath: (recordedPath: string) => string;
  /** Reads one attachment file; `readFileSync` outside tests. */
  readonly readFile: (absolutePath: string) => Buffer;
  readonly warn: (message: string) => void;
  /** The nukadoko version that ran the scenarios. */
  readonly nukadokoVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly success: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalizes a root-relative filesystem path to the POSIX separators
 * cucumber-messages `uri` fields use, regardless of which separator the
 * host OS's own `path` produced — a small, deliberate duplicate of
 * src/report/allure/identity.ts's own `toPosixPath`: importing from
 * the allure/ directory would make this writer, meant to be that
 * directory's sibling and not its dependent, reach sideways into it. */
function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function buildMeta(version: string): Meta {
  return {
    protocolVersion,
    // The version that ran the scenarios, as run.json records it, not the
    // one rendering the stream.
    implementation: { name: "nukadoko", version },
    runtime: { name: "node", version: process.versions.node },
    os: { name: process.platform },
    cpu: { name: process.arch },
    // `ci` omitted: detecting it needs a
    // separate package, which nukadoko doesn't add a dependency on for this.
  };
}

export function writeMessagesStream(
  options: MessagesStreamOptions,
  features: readonly MessagesFeatureInput[],
  scenarios: readonly MessagesScenarioInput[],
): void {
  const newId = IdGenerator.uuid();
  const append = (envelope: Envelope): void => {
    options.write(`${JSON.stringify(envelope)}\n`);
  };
  // `afterStep` is keyed by `step_index`, mirroring `before`/`after` but
  // one id per index rather than one for the whole run (map-scenario.ts's
  // own `MapScenarioInput.hookIds` header explains why).
  let hookIds: { before?: string; after?: string; afterStep?: Record<number, string> } = {};

  // A declared file attachment's bytes are always BASE64-encoded, even for
  // text: either encoding is equally lossless, so no branch is worth
  // adding. A `"built"` plan (a declared log line) is already a complete
  // `Attachment`, map-scenario.ts's job.
  function writeAttachment(plan: MessagesAttachmentPlan): void {
    if (plan.kind === "built") {
      append({ attachment: plan.attachment });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = options.readFile(options.resolvePath(plan.relativePath));
    } catch (error) {
      options.warn(`messages: could not read attachment ${plan.relativePath}: ${errorMessage(error)}`);
      return;
    }
    append({
      attachment: {
        body: bytes.toString("base64"),
        contentEncoding: AttachmentContentEncoding.BASE64,
        mediaType: plan.mediaType,
        fileName: plan.fileName,
        testCaseStartedId: plan.testCaseStartedId,
        testStepId: plan.testStepId,
      },
    });
  }

  append({ meta: buildMeta(options.nukadokoVersion) });
  // One (`source`, `gherkinDocument`, `pickle`*N) group per feature, every
  // envelope of a group under that file's one uri, so a reader joining the
  // three by uri can never cross two files. `gherkinDocument.uri` first,
  // falling back to the POSIX form of the relative path, then stamped onto
  // all three rather than trusted to already agree.
  //
  // cucumber-messages has no field for the environment a test case ran
  // against, and a run over two environments executes each pickle once
  // per environment. Two test cases of one pickle read as one scenario
  // run twice, so a run over more than one environment gives each
  // (pickle, environment) its own pickle: fresh ids, and the environment
  // in parentheses after the name, the same way an Examples row already
  // gives each row its own pickle. A run over one environment keeps the
  // pickles as parsed.
  const environments = new Set(scenarios.map((scenario) => scenario.record.environment));
  const perEnvironment = new Map<Pickle, Map<string, Pickle>>();
  if (environments.size > 1) {
    for (const scenario of scenarios) {
      const copies = perEnvironment.get(scenario.pickle) ?? new Map<string, Pickle>();
      perEnvironment.set(scenario.pickle, copies);
      if (copies.has(scenario.record.environment)) continue;
      copies.set(scenario.record.environment, {
        ...scenario.pickle,
        id: newId(),
        name: `${scenario.pickle.name} (${scenario.record.environment})`,
        steps: scenario.pickle.steps.map((step) => ({ ...step, id: newId() })),
      });
    }
  }
  const pickleFor = (scenario: MessagesScenarioInput): Pickle =>
    perEnvironment.get(scenario.pickle)?.get(scenario.record.environment) ?? scenario.pickle;

  for (const feature of features) {
    const uri = feature.gherkinDocument.uri ?? toPosixPath(feature.relativeFeaturePath);
    append({ source: { uri, data: feature.source, mediaType: SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN } });
    append({ gherkinDocument: { ...feature.gherkinDocument, uri } });
    for (const pickle of feature.pickles) {
      const copies = perEnvironment.get(pickle);
      for (const each of copies === undefined ? [pickle] : copies.values()) {
        append({ pickle: { ...each, uri } });
      }
    }
  }
  append({ testRunStarted: { timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(Date.parse(options.startedAt)) } });

  // `--repeat` executes one pickle more than once in one environment; each
  // later execution is the next attempt of that test case's pickle.
  const attempts = new Map<Pickle, number>();
  for (const scenario of scenarios) {
    const pickle = pickleFor(scenario);
    const attempt = attempts.get(pickle) ?? 0;
    attempts.set(pickle, attempt + 1);
    let mapped: ReturnType<typeof mapScenario>;
    try {
      mapped = mapScenario({ record: scenario.record, stepRecords: scenario.stepRecords, pickle, newId, hookIds });
    } catch (error) {
      options.warn(`messages: scenario ${scenario.record.scenario_record_id} was left out: ${errorMessage(error)}`);
      continue;
    }
    for (const entry of mapped.newHooks) {
      append({ hook: entry.hook });
      if (entry.type === "after_step") {
        hookIds = { ...hookIds, afterStep: { ...hookIds.afterStep, [entry.stepIndex]: entry.hook.id } };
      } else {
        hookIds = { ...hookIds, [entry.type]: entry.hook.id };
      }
    }
    append({ testCase: mapped.testCase });
    append({ testCaseStarted: { ...mapped.testCaseStarted, attempt } });
    for (const step of mapped.steps) {
      append({ testStepStarted: step.testStepStarted });
      for (const attachment of step.attachments) {
        writeAttachment(attachment);
      }
      append({ testStepFinished: step.testStepFinished });
    }
    append({ testCaseFinished: mapped.testCaseFinished });
  }

  append({
    testRunFinished: {
      success: options.success,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(Date.parse(options.finishedAt)),
    },
  });
}
