# frozen_string_literal: true

# The `nuka` command. With --json it prints one envelope in the shape the
# TypeScript engine prints, so an agent reads both engines the same way.
module Nukadoko
  class CLI
    FLAGS = %w[--json --no-check --dry-run].freeze
    REPEATED = %w[--tag --env].freeze
    VALUED = %w[--format --out].freeze

    def initialize(argv, project: Dir.pwd, out: $stdout)
      @command, *rest = argv
      @options = Hash.new { |h, k| h[k] = [] }
      @rest = []
      @unknown = []
      parse(rest)
      @json = @options.key?("--json")
      @no_check = @options.key?("--no-check")
      @project = File.expand_path(project)
      @out = out
    end

    def call
      return refuse(Engine::Refusal.new("invalid-arguments", "Unknown argument: #{@unknown.first}")) if @unknown.any?
      return verdict if @command == "verdict"
      return report if @command == "report"
      return clean if @command == "clean"

      %w[nukadoko.config.rb nukadoko.program.rb].each do |name|
        file = File.join(@project, name)
        load file if File.exist?(file)
      end
      steps = Nukadoko.load_steps(File.join(@project, "features", "steps"))
      scenarios = Dir.chdir(@project) { Engine.load_features("features") }
      check = Engine::Check.new(steps, scenarios)
      findings = check.findings.map { relative(_1).to_h }
      case @command
      when "check" then finish("check", check.passed?, findings: findings)
      when "sig"
        path = File.join(@project, "sig", "nukadoko", "steps.rbs")
        FileUtils.mkdir_p(File.dirname(path))
        File.write(path, Signature.of(steps))
        @out.puts "wrote #{path.delete_prefix("#{@project}/")}"
        0
      when "steps"
        entries = check.usable.sort_by(&:file)
        return finish("steps", true, findings: findings, steps: entries.map { Vocabulary.entry(_1, @project) }) if @json

        @out.puts entries.map { Vocabulary.text(_1) }.join("\n\n")
        0
      when "describe"
        step = check.usable.find { _1.step_name == @rest.first }
        @json = true
        unless step
          refusal = { severity: "refused", code: "unknown-step", message: "Unknown step: #{@rest.first}", fix: "Name a step that nuka steps lists.", do: "nuka steps" }
          return finish("describe", false, findings: findings + [refusal], verdict: "refused")
        end

        finish("describe", true, findings: findings, **Vocabulary.describe(step, @project))
      when "run" then run(steps)
      else
        warn "usage: nuka check|run|verdict|steps|describe <step>|sig [--json] [--no-check]"
        2
      end
    end

    private

    # `--name value` and `--name=value` for the repeated options, bare
    # flags, and every other word a target. An unknown `--name` is kept to
    # refuse, so a typo never reads as a target or is silently ignored.
    def parse(words)
      until words.empty?
        word = words.shift
        name, value = word.split("=", 2)
        if REPEATED.include?(name) || VALUED.include?(name)
          value ||= words.shift
          next @unknown << name.delete_prefix("--") if value.nil?

          @options[name] << value
        elsif FLAGS.include?(word) then @options[word]
        elsif word.start_with?("--") then @unknown << name.delete_prefix("--")
        else @rest << word
        end
      end
    end

    # A run checks the scenarios it selected, then runs them in each world
    # it selected; a target or a world it cannot reach is refused first.
    def run(steps)
      selection = Engine::Selection.new(@project, @rest, @options["--tag"])
      program = Engine::Program.new(Nukadoko.program_options)
      environments = program.environments(@options["--env"])
      # A scenario whose conditions hold in no environment of the run is
      # left out, and counted, since no cell of it could show it holds.
      kept, left_out = selection.scenarios.partition { meets?(_1, environments) }
      check = Engine::Check.new(steps, kept)
      # Under --no-check no finding of the check is reported, as none held the run back.
      findings = @no_check ? [] : check.findings.map { relative(_1).to_h }
      unless @no_check || check.passed?
        errors = findings.select { _1[:severity] == "error" }
        stop = { severity: "refused", code: "check-errors",
                 message: "nuka run did not start: nuka check reports #{errors.size} #{errors.size == 1 ? "error" : "errors"} for these scenarios",
                 fix: "Correct each error the findings name, or pass --no-check to run anyway.", do: check_command }
        return finish("run", false, findings: errors + [stop], verdict: "refused", exit_code: 2)
      end
      if kept.empty? && left_out.any?
        return finish("run", false, findings: [left_out_stop(left_out, program)], verdict: "failed", exit_code: 1)
      end

      result = Engine::Run.new(@project, check.usable, kept, Nukadoko.program_options,
                               environments: environments, left_out: left_out.size, out: @json ? $stderr : @out).call
      passed = result.delete(:passed)
      findings += result.delete(:failures)
      started = result.slice(:run_id, :run_dir, :started_at, :finished_at, :commit, :environments, :worlds)
      rest = result.except(*started.keys)
      envelope = { **head("run", passed ? "passed" : "failed", findings, check: @no_check ? "skipped" : "ran"),
                   **started, selection: selection.selection, tag_selection: selection.tag_selection, **rest }
      envelope.delete(:tag_selection) unless envelope[:tag_selection]
      File.write(File.join(@project, result[:run_dir], "run.json"), "#{JSON.pretty_generate(envelope)}\n")
      # The summary is rendered from run.json as written, so it can say
      # nothing the record does not.
      written = JSON.parse(JSON.generate(envelope), symbolize_names: true)
      File.write(File.join(@project, result[:run_dir], "summary.md"), Engine::Summary.render(written))
      unless @json
        @out.puts "summary   #{File.join(result[:run_dir], "summary.md")}"
        @out.puts "run       #{File.join(result[:run_dir], "run.json")}"
      end
      emit(envelope, findings, "run")
      passed ? 0 : 1
    rescue Engine::Refusal => e
      refuse(e)
    end

    def meets?(scenario, environments)
      tags = Engine::Table.condition_tags(scenario.tags)
      environments.any? { Engine::Table.role(tags, _1.conditions) == "required" }
    end

    # The `nuka check` that reports the same errors: the files the targets
    # name, and each --env.
    def check_command
      files = @rest.map { _1.sub(/:\d+\z/, "") }.uniq
      ["nuka check", *files.map { Engine::Selection.shell_word(_1) }, *@options["--env"].flat_map { ["--env", Engine::Selection.shell_word(_1)] }].join(" ")
    end

    # Why --env left out every selected scenario, and the run that meets
    # them: the run without --env when it does, else the first environment
    # of the program file that meets each, or else one that meets some.
    def left_out_stop(left_out, program)
      envs = @options["--env"]
      count = left_out.size
      them = count == 1 ? "it" : "them"
      meets_each = ->(names) { left_out.all? { meets?(_1, names.map { |name| program.environment(name) }) } }
      defaults = program.default_names
      without = "A run without --env selects #{defaults.join(", ")} (#{program.chosen_by})"
      rerun = ->(env) { ["nuka run", *[*@rest, *env].map { Engine::Selection.shell_word(_1) }].join(" ") }
      message = "no scenario to run: the conditions of the #{count} selected #{count == 1 ? "scenario" : "scenarios"} hold in no environment --env names (#{envs.join(", ")}), so nothing was checked"
      finding = { severity: "failed", code: "nothing-selected", message: message }
      return finding.merge(fix: "#{without}, which meets #{them}.", do: rerun.([])) if meets_each.(defaults)

      candidates = [*program.declared.keys, *("default" unless program.declared.key?("default"))] - envs
      other = candidates.find { meets_each.([_1]) } || candidates.find { |name| left_out.any? { meets?(_1, [program.environment(name)]) } }
      unless other
        return finding.merge(fix: "#{without}, which does not meet #{them} either, and no environment of nukadoko.program.rb meets #{them}. " \
                                  "Declare the conditions #{count == 1 ? "it needs" : "they need"} on an environment, or change #{count == 1 ? "its" : "their"} tags.")
      end

      finding.merge(fix: "#{without}, which does not meet #{them} either. #{other} meets #{meets_each.([other]) ? them : "some of them"}.",
                    do: rerun.(["--env", other]))
    end

    # Removes what runs left in the state directory: each run directory,
    # each `nuka do` record, the Allure results nukadoko wrote, and the
    # directories an earlier release left. --dry-run lists them only.
    def clean
      state = File.join(@project, ".nukadoko")
      listed = ->(dir) { Dir.children(File.join(state, dir)).select { File.directory?(File.join(state, dir, _1)) }.sort.map { ".nukadoko/#{dir}/#{_1}" } rescue [] }
      results = File.join(state, "export", "allure-results")
      plan = {
        records: listed.("runs") + listed.("do"),
        export: File.directory?(results) && !Dir.empty?(results) ? [".nukadoko/export/allure-results"] : [],
        legacy: %w[cache records].select { File.directory?(File.join(state, _1)) }.map { ".nukadoko/#{_1}" },
        kept: []
      }
      dry_run = @options.key?("--dry-run")
      gone = plan[:records] + plan[:export] + plan[:legacy]
      if @json
        emit({ **head("clean", "passed", []), **plan, dry_run: dry_run }, [], "clean")
      else
        gone.each { @out.puts _1 }
        @out.puts "ok: nothing to clean" if gone.empty?
      end
      return 0 if dry_run

      gone.each { FileUtils.rm_rf(File.join(@project, _1)) }
      # An `allure watch` already pointed at the results directory keeps
      # finding it.
      FileUtils.mkdir_p(results) if plan[:export].any?
      0
    end

    # Renders a finished run again from its run.json alone: the run a
    # directory names, or the newest one.
    def report
      format = @options["--format"].last
      out = @options["--out"].last
      raise Engine::Refusal.new("invalid-arguments", "Missing required argument: format") unless format
      unless %w[markdown allure messages].include?(format)
        raise Engine::Refusal.new("invalid-arguments", %(Invalid values:;   Argument: format, Given: #{JSON.generate(format)}, Choices: "markdown", "allure", "messages"))
      end
      unless format == "markdown"
        raise Engine::Refusal.new("invalid-value", "nuka report --format #{format} is not in the Ruby engine yet: it renders --format markdown",
                                  fix: "Pass --format markdown.")
      end
      if @json && !out
        raise Engine::Refusal.new("invalid-arguments", "nuka report --json needs --out for --format markdown, since the markdown output itself would go to stdout",
                                  fix: "Add --out <path>.")
      end

      doc = JSON.parse(File.read(File.join(report_dir, "run.json"), encoding: "UTF-8"), symbolize_names: true)
      markdown = Engine::Summary.render(doc)
      return (@out.write(markdown) && 0) unless out

      target = File.expand_path(out, @project)
      FileUtils.mkdir_p(File.dirname(target))
      File.write(target, markdown)
      written = Pathname.new(target).relative_path_from(Pathname.new(@project)).to_s
      return finish("report", true, findings: [], run_id: doc[:run_id], format: format, written: [written]) if @json

      @out.puts "markdown  #{written}"
      0
    rescue Engine::Refusal => e
      refuse(e)
    end

    def report_dir
      if (named = @rest.first)
        dir = File.expand_path(named, @project)
        return dir if File.file?(File.join(dir, "run.json"))

        raise Engine::Refusal.new("run-not-found", "#{dir} holds no run.json that nuka run wrote",
                                  fix: Engine::Codes.fix("run-not-found"), run: "nuka report --help")
      end
      newest = Engine::Verdict.newest_run(@project)
      raise Engine::Refusal.new("run-not-found", "no run under .nukadoko/runs has a run.json", fix: Engine::Codes.fix("run-not-found"), run: "nuka run") unless newest

      File.join(@project, newest[:run_dir] || File.join(".nukadoko", "runs", newest[:run_id]))
    end

    # Reads run.json files and git only, so it loads no step.
    def verdict
      answer = Engine::Verdict.new(@project)
      if @json
        emit({ **head("verdict", answer.open? ? "failed" : "passed", answer.findings), **answer.envelope_fields }, answer.findings, "verdict")
      else
        @out.puts answer.headline
        emit({}, answer.findings, "verdict")
      end
      answer.open? ? 1 : 0
    end

    def refuse(refusal)
      finish(@command, false, findings: [refusal.to_h(@command)], verdict: refusal.severity, exit_code: refusal.exit_code)
    end

    def relative(finding)
      finding.with(file: finding.file&.delete_prefix("#{@project}/"))
    end

    # Every envelope opens the same way, in the TypeScript engine's order.
    def head(command, verdict, findings, **more)
      { schema_version: Engine::RunRecord::SCHEMA_VERSION, nukadoko: VERSION, command: command, **more, verdict: verdict, findings: findings }
    end

    def finish(command, passed, findings:, verdict: passed ? "passed" : "failed", exit_code: passed ? 0 : 1, **rest)
      emit({ **head(command, verdict, findings), **rest }, findings, command)
      exit_code
    end

    def emit(envelope, findings, command)
      if @json
        @out.puts JSON.pretty_generate(envelope)
      else
        findings.each do |f|
          @out.puts [f[:severity], f[:code], Engine::Summary.where_of(f), f[:message]].join("\t")
          @out.puts "  fix: #{f[:fix]}" if f[:fix]
          @out.puts "  do: #{f[:do]}" if f[:do]
        end
        @out.puts "ok: no issues found" if command == "check" && findings.empty?
      end
    end
  end
end
