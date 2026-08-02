import type { RuntimeMessage } from "allure-js-commons/sdk";
import { MessageTestRuntime, setGlobalTestRuntime } from "allure-js-commons/sdk/runtime";
import { getActiveDeclaredCollector, normalizeFileExtension } from "./declared.js";

// Responsibility: the interception point itself (m2d-allure-shim task spec,
// item 1; verified in .claude-team/m3-allure-research.md section 10.2) — a
// `MessageTestRuntime` subclass that turns every allure-js facade call
// (label/link/parameter/attachment/step/logStep — whichever module instance
// of "allure-js-commons" a step file's own import resolved to; the
// interception itself lives on `globalThis`, not on any one module instance,
// so that never matters, see this file's own `registerAllureRuntime`) into a
// write against src/compat/declared.ts's "currently active" collector.
// Registered exactly once, for `nuka run`'s whole process lifetime (src/cli/
// run.ts calls `registerAllureRuntime()` at the top of the execution phase)
// — never per pickle: src/run/run-scenario.ts is what repoints which
// collector is active, per pickle and per step/hook boundary.
//
// v1 message mapping (this task's spec, decision 3) — the exhaustive list of
// what this class actually reads out of the stream; everything else is
// silently dropped (`default:` below), a documented v1 scope decision, not
// an oversight (see this slice's own task report for the full ignored-kind
// list):
//   - `metadata` -> declared.labels / .links / .parameters (this message's
//     own `description`/`descriptionHtml`/`testCaseId`/`historyId`/
//     `displayName` fields are dropped: no receipt field exists for them
//     yet).
//   - `step_start` + `step_stop` -> one `declared.logs` entry each, paired
//     LIFO on this instance's own stack (nesting is unlikely in practice via
//     `logStep`, but `step(name, fn)` can nest, and this still pairs
//     correctly either way); the future progress-log feature is the
//     intended place these get to keep their own shape ("progress log 実装時
//     に昇格" — this task's spec, decision 3).
//   - `attachment_content` -> a file under the active collector's current
//     boundary directory, plus a `declared.attachments` entry.
// Ignored entirely (not mapped to anything): `step_metadata` (StepContext's
// own `displayName`/`parameter`), `attachment_path`/`attachTrace`,
// `global_attachment_content`, `global_attachment_path`, `global_error`
// (Allure-3 run-level concepts with no scenario/step home in nukadoko's own
// model yet), and the separate `allure-js-commons/sync` facade entry point
// entirely (this class implements only the async `sendMessage`, never
// `sendMessageSync`, so `.sync` stays `undefined` and any sync-facade caller
// falls back to allure-js-commons' own `NoopTestRuntime.sync`).
//
// Concurrency note: see src/compat/declared.ts's own header — this is the
// same process-wide-singleton hedge, extended to the registration itself.

export class NukadokoAllureTestRuntime extends MessageTestRuntime {
  private readonly openStepNames: string[] = [];

  async sendMessage(message: RuntimeMessage): Promise<void> {
    const collector = getActiveDeclaredCollector();
    if (!collector) {
      // No pickle is currently executing (between scenarios, or a stray
      // call from outside `nuka run` entirely) — nothing to attribute this
      // to; dropped the same way allure-js-commons' own `NoopTestRuntime`
      // would drop it if nothing were registered at all.
      return;
    }

    switch (message.type) {
      case "metadata": {
        const { labels, links, parameters } = message.data;
        if (labels && labels.length > 0) {
          collector.recordLabels(labels);
        }
        if (links && links.length > 0) {
          collector.recordLinks(links);
        }
        if (parameters && parameters.length > 0) {
          collector.recordParameters(parameters.map(({ name, value }) => ({ name, value })));
        }
        break;
      }
      case "step_start": {
        this.openStepNames.push(message.data.name);
        break;
      }
      case "step_stop": {
        const name = this.openStepNames.pop() ?? "(unnamed step)";
        const detail = message.data.statusDetails?.message;
        collector.recordLog(
          detail
            ? `${name}: ${message.data.status} (${detail})`
            : `${name}: ${message.data.status}`,
        );
        break;
      }
      case "attachment_content": {
        const { name, content, encoding, fileExtension } = message.data;
        collector.recordAttachment(
          name,
          Buffer.from(content, encoding),
          normalizeFileExtension(fileExtension),
        );
        break;
      }
      default:
        // step_metadata / attachment_path / global_* — v1 scope decision,
        // see this file's own header.
        break;
    }
  }
}

const ALLURE_TEST_RUNTIME_KEY = "allureTestRuntime";

/** Registers `NukadokoAllureTestRuntime` as the process's global allure-js
 * `TestRuntime` (this task's spec, item 1) — called once, at the top of
 * `nuka run`'s execution phase (src/cli/run.ts). Returns a best-effort
 * restore callback: captures whatever was at
 * `globalThis["allureTestRuntime"]` beforehand (nothing, in every case this
 * repo's own test suite exercises) and puts it back when called — "解除" is
 * a direct `globalThis` write, not an official unregister API, because
 * allure-js-commons does not publish one (verified: .claude-team/
 * m3-allure-research.md section 10.2 lists `setGlobalTestRuntime`/
 * `getGlobalTestRuntime` as the whole public surface). The key name itself
 * is the one documented fact this relies on staying stable
 * (`ALLURE_TEST_RUNTIME_KEY` in allure-js-commons' own sdk/runtime/
 * runtime.ts) — an official adapter (e.g. allure-cucumberjs) never needs to
 * restore it since it owns the whole process's test run; nukadoko is more
 * conservative here since `runRun()` can be called more than once in the
 * same process (this repo's own test suite does exactly that). */
export function registerAllureRuntime(): () => void {
  const globalRecord = globalThis as Record<string, unknown>;
  const previous = globalRecord[ALLURE_TEST_RUNTIME_KEY];
  setGlobalTestRuntime(new NukadokoAllureTestRuntime());
  return () => {
    if (previous === undefined) {
      delete globalRecord[ALLURE_TEST_RUNTIME_KEY];
    } else {
      globalRecord[ALLURE_TEST_RUNTIME_KEY] = previous;
    }
  };
}
