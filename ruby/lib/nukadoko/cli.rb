# frozen_string_literal: true

# The `nuka` command. With --json it prints one envelope in the shape the
# TypeScript engine prints, so an agent reads both engines the same way.
module Nukadoko
  class CLI
    FLAGS = %w[--json --no-check].freeze
    REPEATED = %w[--tag --env].freeze

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
        warn "usage: nuka check|run|steps|describe <step>|sig [--json] [--no-check]"
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
        if REPEATED.include?(name)
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
      environments = Engine::Program.new(Nukadoko.program_options).environments(@options["--env"])
      check = Engine::Check.new(steps, selection.scenarios)
      findings = check.findings.map { relative(_1).to_h }
      unless @no_check || check.passed?
        stop = { severity: "refused", code: "check-errors", message: "nuka run did not start: nuka check reports errors for these scenarios" }
        return finish("run", false, findings: findings + [stop], verdict: "refused", exit_code: 2)
      end

      result = Engine::Run.new(@project, check.usable, selection.scenarios, Nukadoko.program_options,
                               environments: environments, out: @json ? $stderr : @out).call
      passed = result.delete(:passed)
      extra = { selection: selection.selection, tag_selection: selection.tag_selection }.compact
      finish("run", passed, findings: findings, **extra, **result)
    rescue Engine::Refusal => e
      refuse(e)
    end

    def refuse(refusal)
      finish(@command, false, findings: [refusal.to_h], verdict: refusal.severity, exit_code: refusal.exit_code)
    end

    def relative(finding)
      finding.with(file: finding.file&.delete_prefix("#{@project}/"))
    end

    def finish(command, passed, findings:, verdict: passed ? "passed" : "failed", exit_code: passed ? 0 : 1, **rest)
      if @json
        @out.puts JSON.pretty_generate({ nukadoko: VERSION, engine: "ruby", command: command, verdict: verdict, findings: findings, **rest })
      else
        findings.each { @out.puts [_1[:severity], _1[:code], [_1[:file], _1[:line]].compact.join(":"), _1[:message]].join("\t") }
        @out.puts "ok: no issues found" if command == "check" && findings.empty?
      end
      exit_code
    end
  end
end
