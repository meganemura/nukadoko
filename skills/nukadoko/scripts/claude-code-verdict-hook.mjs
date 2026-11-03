#!/usr/bin/env node
// Responsibility: an example Claude Code hook, opt-in, that holds an agent
// back once from ending a turn that changed the working tree while
// `nuka verdict` says no run speaks for that tree, or the newest run left
// something red. It reads the answer through `nuka verdict --json` and
// never starts a run: a run can take minutes, and which features and which
// base to run is the agent's call. Nothing installs it; a project that
// wants it names it in its own .claude/settings.json
// (references/done.md).
//
// Two events, one script:
// - UserPromptSubmit keeps the working tree id the turn started from, so
//   Stop can tell a turn that changed nothing (a question, a review) from
//   one that changed files. Without it, every turn in an unjudged tree
//   would be held.
// - Stop asks `nuka verdict`. It holds the turn only when the tree moved
//   during the turn and the verdict is failed, and never when
//   `stop_hook_active` is true: the stop after a hold goes through, so the
//   agent can end by saying what stays unproven instead of being looped.
//
// The input fields read (`hook_event_name`, `session_id`, `cwd`,
// `stop_hook_active`) and the output (`decision: "block"` with `reason`,
// which Stop reads as the instruction to continue) are Claude Code's hook
// contract as of 2.1.317. A host or a version that names them otherwise
// gets no hold: every unreadable case exits 0 with nothing on stdout.
//
// Plain JavaScript, not TypeScript: Node refuses to strip types from a
// file under node_modules, where this script is read from.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readInput();
// Hooks may start outside the project; Claude Code names it in the
// environment, and `cwd` on stdin is where the session is.
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const sessionId = String(input.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
// Under the system temp directory, not the project: a file the hook left
// in the project would be a change git counts, and would move the very
// tree the verdict compares.
const startFile = path.join(tmpdir(), "nukadoko-verdict-hook", `${sessionId}.tree`);

// Only the project's own installed nuka: `npx nuka` without one would
// fetch a package from the registry inside a hook.
const nuka = path.join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "nuka.cmd" : "nuka");
const configured = ["ts", "mts", "js", "mjs"].some((ext) => existsSync(path.join(projectDir, `nukadoko.config.${ext}`)));
if (!configured || !existsSync(nuka)) process.exit(0);

function verdict() {
  const result = spawnSync(nuka, ["verdict", "--json"], { cwd: projectDir, encoding: "utf8", shell: process.platform === "win32" });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

if (input.hook_event_name === "UserPromptSubmit") {
  const answer = verdict();
  if (typeof answer?.working_tree === "string") {
    mkdirSync(path.dirname(startFile), { recursive: true });
    writeFileSync(startFile, answer.working_tree);
  }
  process.exit(0);
}

if (input.hook_event_name !== "Stop" || input.stop_hook_active === true) process.exit(0);

const answer = verdict();
// `refused` is a project nuka cannot read (a config that does not load):
// a hold would ask for something no run can give.
if (answer === null || answer.verdict !== "failed") process.exit(0);
const startTree = existsSync(startFile) ? readFileSync(startFile, "utf8").trim() : null;
if (startTree !== null && startTree === answer.working_tree) process.exit(0);

const open = (answer.findings ?? [])
  .filter((finding) => finding.severity === "failed" || finding.severity === "error")
  .map((finding) => {
    const where = finding.file === undefined ? "" : ` ${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`;
    return `- ${finding.code}${where}: ${finding.message}${finding.do === undefined ? "" : ` (do: ${finding.do})`}`;
  });
const reason = [
  startTree === null
    ? "`nuka verdict` says no run speaks for this working tree yet:"
    : "This turn changed the working tree, and `nuka verdict` says no run speaks for it yet:",
  ...open,
  "Before you say the change is done, run the criteria it touches and read the verdict table.",
  "If you cannot run them, or a row stays red, end by naming each criterion that is unproven, failed, or not run, and why.",
].join("\n");
process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
