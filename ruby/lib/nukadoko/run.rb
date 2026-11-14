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
        records = scenario.steps.map do |line|
          record = stopped ? skipped(line) : play_step(line, results, world)
          stopped ||= [record[:outcome], line.line, record[:claim]] if record[:status] == "failed"
          @out.puts "  #{record[:status]}  #{line.text}"
          @out.puts "      #{record[:error]}" if record[:error]
          record
        end
        @browser.end_scenario
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
        begin
          args = bind_args(step, captures, line, results)
          record[:args] = args
          problems = step.args.problems(args)
          raise TypeError, "args: #{problems.join("; ")}" if problems.any?

          fixtures, finish = build_fixtures(step, dir, log, world)
          if step.claims
            observed = step.method_defined?(:observe) ? step.new.observe(**fixtures, args: step.inputs.load(args)) : args
            judged = Claims.judge(step.claims, observed, args)
            record[:claims] = judged
            broken = judged.index { !_1[:holds] }
            record.merge!(status: "failed", outcome: line_kind(line) == :then ? :fail : :broke, claim: broken, error: "claim #{broken} broke") if broken
          else
            value = step.new.run(**fixtures, args: step.inputs.load(args))
            problems = step.returns ? step.returns.problems(value) : []
            raise TypeError, "returns: #{problems.join("; ")}" if problems.any?

            results << [step, value.transform_keys(&:to_s)]
            record[:result] = value
          end
          record[:status] ||= "passed"
        rescue StandardError => e
          record.merge!(status: "failed", outcome: :broke, error: "#{e.class}: #{e.message}")
        ensure
          finish&.call
          log.concat(fixtures[:request].log) if fixtures[:request]
          record[:finished_at] = Time.now.utc.iso8601(3)
          record[:observed] = { http: log.size }
          File.write(File.join(dir, "http.jsonl"), log.map { JSON.generate(_1) }.join("\n"))
          File.write(File.join(dir, "record.json"), JSON.pretty_generate(record))
        end
        record
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

      def build_fixtures(step, dir, log, world)
        finish = nil
        fixtures = step.fixtures.to_h do |name|
          case name
          when :request then [name, Request.new(world.base_url)]
          when :baseURL then [name, world.base_url]
          when :page
            page, finish = @browser.page_for(dir, log)
            [name, page]
          else raise ArgumentError, "the Ruby engine has no fixture #{name} yet"
          end
        end
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
