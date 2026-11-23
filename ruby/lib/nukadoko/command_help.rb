# frozen_string_literal: true
# rbs_inline: enabled

# What `nuka <command> --help` prints: the command's usage, what it is for, and the flags
# it reads. The flags listed here are the ones the command acts on, so the table of what
# each engine offers (docs/engines.json) can be checked against this text, and a refusal
# that says "the command's --help lists its flags" points at something that exists.
module Nukadoko
  module CommandHelp
    # @rbs!
    #   type entry = { usage: String, summary: String, flags: Array[[String, String]] }

    JSON_FLAG = ["--json", "machine-readable output"].freeze #: [String, String]

    COMMANDS = {
      "init" => {
        usage: "nuka init",
        summary: "set up a project; ends with a self-check",
        flags: [["--allure", "also write allurerc.mjs and an empty .nukadoko/export/allure-results/ for nuka report --format allure"]]
      },
      "scaffold" => {
        usage: "nuka scaffold [name]",
        summary: "typed step template that fails until implemented",
        flags: [
          ["--feature <path>", "a feature file or a directory of them: write one stub for each line nuka check calls undefined-step"],
          ["--pattern <text>", "the feature line text the step matches; each {key:type} capture becomes an args field"],
          ["--then", "a claim step for a Then line: claims in place of run, against a value the line states"],
          ["--command [entry point]", "a When step that runs a program in scratch.dir (or in --cwd's directory) and returns exitCode, stdout, and stderr"],
          ["--description <text>", "what the step does, written as its description; without it the description is a TODO nuka check reports"],
          ["--from <step>.<key>", "chain that key of an earlier step's returns into args; repeatable"],
          ["--cwd <key>", "with --command: run the program in the directory this args key holds"],
          ["--argv <key>", "with --command: split this string capture into argv elements on whitespace"],
          ["--request \"<METHOD> <path>\"", "a When step that sends one request and returns status and body"],
          ["--body <key>", "with --request: send this args key as the request's data"],
          ["--replace", "overwrite the step file while it is still, byte for byte, what scaffold writes; any other file is refused"]
        ]
      },
      "check" => {
        usage: "nuka check [feature..]",
        summary: "static checks: pattern/schema mismatches, claim steps and where they are bound, undefined steps per feature, " \
                 "duplicate patterns, config coherence, and notes on unused declarations",
        flags: [JSON_FLAG,
                 ["--fail-on <code>", "exit 1 when a finding with this code is reported (repeatable, or comma-separated); the finding keeps its " \
                                      "severity in the output, only the exit code changes. For a job that gates on one note, such as pattern-unbound"],
                 ["--codes", "list every finding code nuka check can produce, with a one-line description, instead of checking a project"],
                 ["--env <name>", "check as a nuka run with the same --env flags would run (repeatable)"]]
      },
      "run" => {
        usage: "nuka run [feature..]",
        summary: "check, then execute scenarios from a feature file or a directory of them (features/ when none is given); step records + run.json",
        flags: [
          ["--no-check", "skip the check before executing, to run a scenario check refuses"],
          ["--env <name>", "target a named environment of the program in nukadoko.config.rb; repeat it to run each selected scenario once in each"],
          ["--tag <expression>", "run only the scenarios whose tags meet this expression, \"@name\" or \"not @name\"; repeat it, and a scenario has to meet every one"],
          ["--records", "write each scenario's run.json entry to stdout as one JSON line, as the scenario finishes"],
          ["--json", "print the run's result (run.json) on stdout as one JSON document, and no progress lines on stderr"],
          ["--concurrency <n>", "run n worker processes at once, one whole feature file per worker (default 1)"],
          ["--repeat <n>", "run every selected scenario n times in this one invocation (default 1)"],
          ["--proof-runs <n>", "run a control cell until the same claim in Then has broken at the same line this many times (default 2)"],
          ["--order file|shuffled[:<seed>]", "the order each environment's pass runs its scenarios in; shuffled:<seed> runs that order again"],
          ["--base <ref>", "compare each scenario with the commit a git ref names: new and changed criteria also run against the base's code"],
          ["--step", "walk one scenario one step at a time; follow it with nuka step wait"]
        ]
      },
      "report" => {
        usage: "nuka report [run]",
        summary: "render a finished run as Markdown, Allure results, or a cucumber-messages stream, from its run directory alone",
        flags: [
          ["--format markdown|allure|messages", "markdown: the run summary; allure: an allure-results directory; messages: a cucumber-messages NDJSON stream"],
          ["--out <path>", "where to write: a file for markdown and messages (stdout without it), a directory for allure"],
          ["--json", "print the result (run id, format, what was written) as one JSON document; needs --out for markdown and messages"]
        ]
      },
      "verdict" => {
        usage: "nuka verdict",
        summary: "say whether the newest run judged the working tree as it is now and left nothing red; exits 1 when it did not, and never starts a run",
        flags: [JSON_FLAG, ["--trailer", "print one git trailer line (Nukadoko-Verdict: ...) and exit 0 whatever it says, to stamp a commit"]]
      },
      "judge" => {
        usage: "nuka judge <target>",
        summary: "show the values a run read for a criterion whose Then asks for a judgment (<feature file>:<scenario line>), " \
                 "or record a judgment of them with --meets or --misses",
        flags: [
          ["--run <id>", "the run whose records hold the values; the newest run that ended when omitted"],
          ["--meets", "record that each value meets the quality its sentence names"],
          ["--misses", "record that each value does not: the criterion fails until the value changes"],
          ["--by <who>", "who judged, as they name themselves"],
          ["--because <sentence>", "why the values meet or miss the sentence, in one sentence"],
          JSON_FLAG
        ]
      },
      "steps" => {
        usage: "nuka steps [feature..]",
        summary: "list the vocabulary: name, patterns, description, mutates; with a target (a feature file, file:line, or directory), " \
                 "only the steps its lines bind and the steps those call through parts, each with the lines that bind it",
        flags: [JSON_FLAG]
      },
      "describe" => { usage: "nuka describe <name>", summary: "full contract, schemas as JSON Schema", flags: [] },
      "do" => {
        usage: "nuka do <name>",
        summary: "execute one typed step; step record to stdout",
        flags: [
          ["--args <json>", "step arguments as a JSON object (may be omitted only when --use supplies every key)"],
          ["--env <name>", "target a named environment"],
          ["--use <record id>", "step record id whose result fills this step's from keys (repeatable)"]
        ]
      },
      "step" => { usage: "nuka step", summary: "follow and answer a walk of nuka run --step, one pause at a time", flags: [] },
      "clean" => {
        usage: "nuka clean",
        summary: "delete accumulated runs, do records, and what nuka report wrote under export/, in the state directory",
        flags: [["--dry-run", "list what would be removed without removing it"], JSON_FLAG]
      },
      "skill" => { usage: "nuka skill", summary: "path the agent-facing skills' source directory", flags: [] },
      "sig" => { usage: "nuka sig", summary: "write sig/nukadoko/steps.rbs, the RBS of each step's args and returns, for Steep", flags: [] }
    }.freeze #: Hash[String, entry]

    #: (String) -> String
    def self.text(command)
      entry = COMMANDS.fetch(command)
      options = [["--help", "Show help"], *entry[:flags]] #: Array[[String, String]]
      width = options.map { |flag, _| flag.length }.max || 0
      lines = [entry[:usage], "", entry[:summary], "", "Options:"]
      lines.concat(options.map { |flag, text| "  #{flag.ljust(width)}  #{text}" })
      "#{lines.join("\n")}\n"
    end
  end
end
