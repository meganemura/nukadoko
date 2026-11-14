# frozen_string_literal: true

require "securerandom"
require "fileutils"
require "time"

# One run: for each environment, start its world, play every scenario's steps
# in order, and write a record per step. A scenario stops at its first step
# that does not pass and skips the rest. A control that fails at a Then runs
# again for proof. The table and the summary come last.
module Nukadoko
  module Engine
    class Run
      def initialize(project, steps, scenarios, program, out: $stdout)
        @project = project
        @steps = steps
        @scenarios = scenarios
        @program = Program.new(program)
        @out = out
        @id = new_id("run")
        @dir = File.join(project, ".nukadoko", "runs", @id)
      end

      def call
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        executions = []
        cells = Hash.new { |h, k| h[k] = [] }
        @program.environments.each do |environment|
          @out.puts "environment #{environment.name}"
          world_dir = File.join(@dir, "worlds", environment.name)
          FileUtils.mkdir_p(world_dir)
          world = @program.start(environment, world_dir, @project)
          @process_fixtures = FixtureCache.new
          @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}))
          @scenarios.each do |scenario|
            role = Table.role(Table.condition_tags(scenario.tags), environment.conditions)
            runs = [play(scenario, environment, role, world)]
            runs << play(scenario, environment, role, world) while proving?(role, runs)
            executions.concat(runs)
            cells[scenario] << Table.cell(runs.map { _1[:execution] }).merge(environment: environment.name, role: role)
          end
        ensure
          @browser&.close
          @process_fixtures&.teardown
          world&.stop
        end
        finish(executions, cells)
      end

      private

      def proving?(role, runs)
        role == "control" && runs.size < Table::PROOF_RUNS && runs.all? { _1[:execution].first == :fail } && runs.map { _1[:execution] }.uniq.size == 1
      end

      def finish(executions, cells)
        rows = @scenarios.map do |scenario|
          row_cells = cells[scenario]
          { feature: scenario.uri, line: scenario.line, name: scenario.name, conditions: Table.condition_tags(scenario.tags),
            cells: row_cells, verdict: Table.verdict(row_cells) }
        end
        write_summary(rows)
        @out.puts "summary   #{File.join(".nukadoko/runs", @id, "summary.md")}"
        { run_id: @id, run_dir: File.join(".nukadoko/runs", @id), scenarios: executions.map { _1[:json] },
          table: { rows: rows }, passed: rows.none? { _1[:verdict] == "failed" } }
      end

      def play(scenario, environment, role, world)
        @out.puts "scenario  #{scenario.uri}:#{scenario.line}  #{scenario.name}#{role == "control" ? "  (control)" : ""}"
        results = []
        stopped = nil
        @scratch = Scratch.new
        @scenario_fixtures = FixtureCache.new
        records = scenario.steps.map do |line|
          record = stopped ? skipped(line) : play_step(line, results, world)
          stopped ||= [record[:outcome], line.line, record[:claim]] if record[:status] == "failed"
          @out.puts "  #{record[:status]}  #{line.text}"
          @out.puts "      #{record[:error]}" if record[:error]
          record
        end
        @browser.end_scenario
        @scenario_fixtures.teardown
        @scratch.remove_all
        execution = stopped ? stopped.compact : [:pass]
        { execution: execution,
          json: { feature: scenario.uri, line: scenario.line, scenario: scenario.name, environment: environment.name, role: role,
                  status: stopped ? "failed" : "passed",
                  steps: scenario.steps.zip(records).map do |line, record|
                    { line: line.line, text: line.text, step: record[:step], status: record[:status], record: record[:step_record_id] }.compact
                  end } }
      end

      def skipped(line) = { step: Engine.matches(@steps, line.text).first&.first&.step_name, status: "skipped" }

      def play_step(line, results, world)
        step, captures = Engine.matches(@steps, line.text).first
        return { status: "failed", outcome: :broke, error: %(no step matches "#{line.text}") } unless step

        id = new_id("step")
        dir = File.join(@dir, "steps", id)
        FileUtils.mkdir_p(dir)
        log = []
        record = { step_record_id: id, step: step.step_name, text: line.text, started_at: Time.now.utc.iso8601(3) }
        fixtures = {}
        finish = nil
        processes = []
        begin
          args = bind_args(step, captures, line, results)
          record[:args] = args
          problems = step.args.problems(args)
          raise TypeError, "args: #{problems.join("; ")}" if problems.any?

          fixtures, finish = build_fixtures(step, dir, log, world)
          Processes.collect(processes) { body(step, fixtures, args, line, record, results) }
          record[:status] ||= "passed"
        rescue StandardError => e
          record.merge!(status: "failed", outcome: :broke, error: "#{e.class}: #{e.message}")
        ensure
          finish&.call
          log.concat(fixtures[:request].log) if fixtures[:request]
          record[:finished_at] = Time.now.utc.iso8601(3)
          record[:processes] = processes if processes&.any?
          record[:calls] = fixtures[:call].calls if fixtures[:call]&.calls&.any?
          record[:observed] = { http: log.size, processes: processes&.size || 0 }
          File.write(File.join(dir, "http.jsonl"), log.map { JSON.generate(_1) }.join("\n"))
          File.write(File.join(dir, "record.json"), JSON.pretty_generate(record))
        end
        record
      end

      # A Then step's claims are judged on what it observed, or on its args
      # when it reads nothing itself; any other step runs and returns.
      def body(step, fixtures, args, line, record, results)
        if step.claims
          own = fixtures.slice(*step.fixtures)
          read = -> { step.method_defined?(:observe) ? step.new.observe(**own, args: step.inputs.load(args)) : args }
          observed = step.poll ? Poll.new(step.poll, step.claims, args).call(record, &read) : read.()
          judged = Claims.judge(step.claims, observed, args)
          record[:claims] = judged
          broken = judged.index { !_1[:holds] }
          record.merge!(status: "failed", outcome: line_kind(line) == :then ? :fail : :broke, claim: broken, error: "claim #{broken} broke") if broken
        else
          value = step.new.run(**fixtures.slice(*step.fixtures), args: step.inputs.load(args))
          problems = step.returns ? step.returns.problems(value) : []
          raise TypeError, "returns: #{problems.join("; ")}" if problems.any?

          if step.returns
            dropped = step.returns.dropped(value)
            record[:returns_dropped] = dropped if dropped.any?
            value = step.returns.strip(value)
          end
          results << [step, value.transform_keys(&:to_s)]
          record[:result] = value
        end
      end

      # Captures first, then each `from` key from the nearest earlier step that
      # gave it, then a table or docstring for the one required key still open.
      def bind_args(step, captures, line, results)
        args = captures.dup
        step.from.each do |key, sources|
          cls, value = results.reverse_each.find { |c, _| sources.any? { _1.first == c } }
          raise ArgumentError, %(no earlier step in this scenario gave "#{key}") unless cls

          args[key] = value.fetch(sources.find { _1.first == cls }[1].to_s)
        end
        open = step.args.fields.map { _1.name.to_s } - args.keys
        attachment = line.table || line.doc_string
        args[open.first] = attachment if attachment && open.any?
        args
      end

      def line_kind(line) = line.kind == "Outcome" ? :then : :other

      # A project fixture is built the first time a step of its scope names
      # it, directly or through another fixture, and kept until the scope ends.
      def project_fixture(name, world, chain)
        fixture = Nukadoko.project_fixtures[name] or raise ArgumentError, "the Ruby engine has no fixture #{name} yet"
        raise ArgumentError, "fixtures depend on each other in a cycle: #{[*chain, name].join(" -> ")}" if chain.include?(name)

        cache = fixture.scope == :process ? @process_fixtures : @scenario_fixtures
        return cache[name] if cache.key?(name)

        deps = fixture.dependencies.to_h do |dep|
          case dep
          when :baseURL then [dep, world.base_url]
          when :scratch then [dep, @scratch]
          else [dep, project_fixture(dep, world, [*chain, name])]
          end
        end
        cache.build(fixture, deps)
      end

      def build_fixtures(step, dir, log, world)
        finish = nil
        fixtures = (step.bag - [:call]).to_h do |name|
          case name
          when :request then [name, Request.new(world.base_url)]
          when :baseURL then [name, world.base_url]
          when :scratch then [name, @scratch]
          when :page
            page, finish = @browser.page_for(dir, log)
            [name, page]
          else [name, project_fixture(name, world, [])]
          end
        end
        fixtures[:call] = Caller.new(step, fixtures) if step.fixtures.include?(:call)
        [fixtures, finish]
      end

      def write_summary(rows)
        verdicts = rows.map { _1[:verdict] }.tally.map { |v, n| "#{n} #{v}" }.join(", ")
        lines = ["# nukadoko run #{rows.none? { _1[:verdict] == "failed" } ? "passed" : "failed"}: #{rows.size} criteria, #{verdicts}", ""]
        rows.each do |r|
          cells = r[:cells].map { |c| "#{c[:environment]} #{c[:outcome]}#{c[:line] ? "@#{c[:line]}" : ""}#{c[:role] == "control" ? " (control)" : ""}" }
          lines << "- #{r[:verdict]}  #{r[:feature]}:#{r[:line]}  #{r[:name]}  #{cells.join(", ")}"
        end
        File.write(File.join(@dir, "summary.md"), "#{lines.join("\n")}\n")
      end

      def new_id(kind) = "#{kind}-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"
    end
  end
end
