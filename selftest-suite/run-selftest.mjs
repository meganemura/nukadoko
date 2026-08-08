#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Responsibility: run this suite (selftest-suite/features/nuka-run.feature)
// on both tracks and fail loudly if they disagree. `npm run selftest` is
// the one command the selftest-suite task spec asks for
// ("どうやって 2 トラックを走らせるかが、コマンド1つで分かること").
//
// ## The two tracks (why there are two at all)
//
// Track 1, baseline: the real `cucumber-js` binary runs this suite, whose
// step files import Given/When/Then/World from
// selftest-suite/features/steps/runtime.ts, which in turn binds to the
// real `@cucumber/cucumber` package. Nothing here touches nukadoko.
//
// Track 2, swap: `nuka run` (nukadoko's own CLI) runs the *same* feature
// file and the *same* step file, with runtime.ts's import swapped to
// `nukadoko/compat` (via NUKADOKO_SELFTEST_TRACK=swap, see runtime.ts's own
// comment). Here, `nuka run` is the OUTER runner driving this suite --
// there is no cucumber-js binary involved on this track at all.
//
// Track 1 has to keep running, permanently, on its own: when the outer
// runner is nukadoko itself, a nukadoko bug can corrupt both the thing
// being measured (whether this suite's scenario actually passed) and the
// instrument doing the measuring (nuka run's own pass/fail report), so
// track 2 alone can never be trusted to catch a nukadoko regression.
// Track 1 is the one place that cannot happen, and it is what track 2 is
// checked against below.
//
// ## Two allure-results trees, easy to confuse (do not conflate them)
//
// Every step in the suite spawns `nuka run` again, as a *subprocess*,
// against selftest-suite/fixture-project -- a separate, tiny nukadoko
// project that only exists to be driven this way. That inner `nuka run`'s
// own `.nukadoko/allure-results/`, under fixture-project/, is what the
// suite's own step assertions check (features/steps/nuka-run.ts).
//
// Separately, on track 2 only, `nuka run` is *also* running as the OUTER
// process (see above), and it writes its own `.nukadoko/allure-results/`
// directly under selftest-suite/ -- this file never reads that tree, and
// neither does any step. Two different projects, two different
// allure-results directories on disk (fixture-project/.nukadoko/... vs
// selftest-suite/.nukadoko/...), only one of which either track's
// assertions ever look at.
//
// ## "Same results", defined precisely
//
// The two tracks are compared on exactly one artifact each, boiled down to
// a `scenario name -> status` map:
//
//   - baseline: `cucumber-js --format json`'s own JSON output. Each
//     `elements[]` entry with `type === "scenario"` contributes its `name`
//     as the key; the value is "passed" if every one of its `steps[]` has
//     `result.status === "passed"`, else "failed". (cucumber-js's JSON
//     format has no single per-scenario status field -- this derivation is
//     the definition, not an approximation of one.)
//   - swap: `nuka run`'s own NDJSON scenario records on stdout (the same
//     shape asserted on throughout tests/run.test.ts). Each line's
//     `scenario` field is the key; `status` is used as-is, since nuka run
//     already reports one status per scenario directly.
//
// The two maps must have the same key set and the same value at every key.
// Nothing else about either track's output is compared.

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = here;
const repoRoot = path.resolve(here, "..");

const cucumberJsBin = path.join(repoRoot, "node_modules", "@cucumber", "cucumber", "bin", "cucumber.js");
const nukaCliBin = path.join(repoRoot, "dist", "cli.js");
const suiteFeature = "features/nuka-run.feature";

function fail(message) {
  console.error(`selftest: ${message}`);
  process.exitCode = 1;
}

async function runBaseline() {
  // cucumber-js 13.2.0 only runs on Node 22, 24, or >=26 (its own
  // package.json `engines`, enforced at startup, not just advisory) --
  // narrower than nukadoko's own `>=20`. If the Node running this script
  // does not satisfy that, this step fails with cucumber-js's own error
  // message, which already names the constraint; run this script under a
  // supported Node version rather than one this repository otherwise
  // supports.
  //
  // `--import tsx` (via NODE_OPTIONS, not cucumber-js's own `--loader`,
  // which tsx explicitly refuses -- see tsx's own error if tried) makes
  // relative `../steps/runtime.js`-style imports inside the suite's `.ts`
  // step files resolve to their `.ts` files, the same extension-rewriting
  // tsx already does for `nuka run`'s own discovery (src/discover/
  // discover-steps.ts uses tsx directly); Node's native TS support has no
  // such rewrite and fails to resolve those imports at all.
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import tsx`.trim() };

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cucumberJsBin,
      "--import",
      "features/steps/**/*.ts",
      "--import",
      "features/support/**/*.ts",
      "--format",
      "json",
      suiteFeature,
    ],
    { cwd: suiteDir, env },
  );

  const document = JSON.parse(stdout);
  const results = new Map();
  for (const feature of document) {
    for (const element of feature.elements ?? []) {
      if (element.type !== "scenario") continue;
      const passed = (element.steps ?? []).every((step) => step.result?.status === "passed");
      results.set(element.name, passed ? "passed" : "failed");
    }
  }
  return results;
}

async function runSwap() {
  const env = { ...process.env, NUKADOKO_SELFTEST_TRACK: "swap" };
  const { stdout } = await execFileAsync(process.execPath, [nukaCliBin, "run", suiteFeature], {
    cwd: suiteDir,
    env,
  });

  const results = new Map();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line);
    results.set(record.scenario, record.status);
  }
  return results;
}

function compare(baseline, swap) {
  if (baseline.size === 0 || swap.size === 0) {
    // A misconfigured path/glob can make either runner exit 0 having found
    // zero scenarios -- a silent false green that an equality check alone
    // would not catch (two empty maps compare equal).
    fail(
      `expected at least one scenario on both tracks, got ${baseline.size} (baseline) and ${swap.size} (swap)`,
    );
    return;
  }

  const baselineKeys = new Set(baseline.keys());
  const swapKeys = new Set(swap.keys());
  const onlyBaseline = [...baselineKeys].filter((key) => !swapKeys.has(key));
  const onlySwap = [...swapKeys].filter((key) => !baselineKeys.has(key));
  if (onlyBaseline.length > 0 || onlySwap.length > 0) {
    fail(
      `scenario names differ between tracks. Only on baseline: ${JSON.stringify(onlyBaseline)}. Only on swap: ${JSON.stringify(onlySwap)}.`,
    );
    return;
  }

  const mismatches = [];
  for (const [name, baselineStatus] of baseline) {
    const swapStatus = swap.get(name);
    if (swapStatus !== baselineStatus) {
      mismatches.push(`"${name}": baseline=${baselineStatus} swap=${swapStatus}`);
    }
  }
  if (mismatches.length > 0) {
    fail(`status mismatch for ${mismatches.length} scenario(s): ${mismatches.join("; ")}`);
    return;
  }

  console.log(`selftest: ${baseline.size} scenario(s) agree on both tracks.`);
  for (const [name, status] of baseline) {
    console.log(`  ${status}  ${name}`);
  }
}

const baseline = await runBaseline().catch((error) => {
  fail(`baseline track (cucumber-js) failed: ${error.message}`);
  return null;
});

if (baseline !== null) {
  const swap = await runSwap().catch((error) => {
    fail(`swap track (nuka run) failed: ${error.message}`);
    return null;
  });

  if (swap !== null) {
    compare(baseline, swap);
  }
}

process.exit(process.exitCode ?? 0);
