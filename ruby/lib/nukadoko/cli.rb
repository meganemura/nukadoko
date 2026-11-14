# frozen_string_literal: true

# The `nuka` command. With --json it prints one envelope in the shape the
# TypeScript engine prints, so an agent reads both engines the same way.
module Nukadoko
  class CLI
    def initialize(argv, project: Dir.pwd, out: $stdout)
      @command, *rest = argv
      @json = rest.delete("--json")
      @no_check = rest.delete("--no-check")
      @rest = rest
      @project = File.expand_path(project)
      @out = out
    end

    def call
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
      when "run"
        return finish("run", false, findings: findings) unless @no_check || check.passed?

        result = Engine::Run.new(@project, check.usable, scenarios, Nukadoko.program_options, out: @json ? $stderr : @out).call
        passed = result.delete(:passed)
        finish("run", passed, findings: findings, **result)
      else
        warn "usage: nuka check|run|steps|describe <step>|sig [--json] [--no-check]"
        2
      end
    end

    private

    def relative(finding)
      finding.with(file: finding.file&.delete_prefix("#{@project}/"))
    end

    def finish(command, passed, findings:, verdict: passed ? "passed" : "failed", **rest)
      if @json
        @out.puts JSON.pretty_generate({ nukadoko: VERSION, engine: "ruby", command: command, verdict: verdict, findings: findings, **rest })
      else
        findings.each { @out.puts [_1[:severity], _1[:code], [_1[:file], _1[:line]].compact.join(":"), _1[:message]].join("\t") }
        @out.puts "ok: no issues found" if command == "check" && findings.empty?
      end
      passed ? 0 : 1
    end
  end
end
