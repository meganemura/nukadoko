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
      def initialize(project, steps, scenarios, program, environments: nil, left_out: 0, out: $stdout)
        @project = project
        @steps = steps
        @scenarios = scenarios
        @program = Program.new(program)
        @environments = environments || @program.environments
        @left_out = left_out
        @out = out
        @id = new_id("run")
        @dir = File.join(project, ".nukadoko", "runs", @id)
      end

      def call
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        @started_at = now
        @commit = RunRecord.commit(@project)
        @base_urls = {}
        executions = []
        cells = Hash.new { |h, k| h[k] = [] }
        @environments.each do |environment|
          @out.puts "environment #{environment.name}"
          world_dir = File.join(@dir, "worlds", environment.name)
          FileUtils.mkdir_p(world_dir)
          world = @program.start(environment, world_dir, @project)
          @base_urls[environment.name] = world.base_url
          @process_fixtures = FixtureCache.new
          @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}))
          @scenarios.each do |scenario|
            role = Table.role(Table.condition_tags(scenario.tags), environment.conditions)
            runs = [play(scenario, environment, role, world)]
            runs << play(scenario, environment, role, world) while proving?(role, runs)
            executions.concat(runs)
            cells[scenario] << cell(runs, environment, role)
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

      # A cell is what one scenario's executions in one environment came to;
      # a cell whose first execution broke a claim names it and what it read.
      def cell(runs, environment, role)
        executions = runs.map { _1[:execution] }
        cell = Table.cell(executions)
        entry = { world: "head", environment: environment.name, role: role, conditions: environment.conditions,
                  outcome: cell[:outcome], line: cell[:line], runs: cell[:runs] }.compact
        if cell[:outcome] == "fail"
          entry[:claim] = executions.first[2]
          entry[:actuals] = runs.map { { value: _1[:actual] } }
        end
        entry
      end

      # run.json is the --json envelope as a file: the commit and worlds the
      # run judged, the counts, each execution, and the verdict table.
      def finish(executions, cells)
        rows = @scenarios.map do |scenario|
          row_cells = cells[scenario]
          verdict, reason = RunRecord.judge_row(row_cells)
          { feature: scenario.uri, line: scenario.line, name: scenario.name, change: nil,
            conditions: Table.condition_tags(scenario.tags), cells: row_cells, verdict: verdict, reason: reason }
        end
        scenarios = executions.map { _1[:json] }
        { run_id: @id, run_dir: File.join(".nukadoko/runs", @id), started_at: @started_at, finished_at: now, commit: @commit,
          environments: @environments.map { environment_entry(_1) }, worlds: [], order: { kind: "file" },
          counts: RunRecord.counts(scenarios), scenarios: scenarios,
          table: { base: nil, mapping_changed: nil, mapping_changes: nil,
                   worlds: @environments.map { { world: "head", environment: _1.name } },
                   rows: rows, left_out: @left_out, proof_runs: Table::PROOF_RUNS },
          failures: executions.filter_map { _1[:failure] }, passed: rows.none? { _1[:verdict] == "failed" } }
      end

      def environment_entry(environment)
        { name: environment.name, conditions: environment.conditions.empty? ? nil : environment.conditions,
          target_version: nil, base_url: @base_urls[environment.name] }.compact.merge(target_version: nil, base_url: @base_urls[environment.name])
      end

      # Where a scenario's run starts again: its line, and its environment
      # unless that is the only one a run without --env would start.
      def again(scenario, environment)
        env = @environments.map(&:name) == ["default"] ? "" : " --env #{environment.name}"
        "nuka run #{scenario.uri}:#{scenario.line}#{env}"
      end

      def play(scenario, environment, role, world)
        @out.puts "scenario  #{scenario.uri}:#{scenario.line}  #{scenario.name}#{role == "control" ? "  (control)" : ""}"
        started_at = now
        results = []
        stopped = nil
        @scratch = Scratch.new
        @scenario_fixtures = FixtureCache.new
        records = scenario.steps.map do |line|
          record = stopped ? skipped(line) : play_step(line, results, world)
          stopped ||= [record[:outcome], line.line, record[:claim], record[:broken_actual]] if record[:status] == "failed"
          @out.puts "  #{record[:status]}  #{line.text}"
          @out.puts "      #{record[:error]}" if record[:error]
          record
        end
        @browser.end_scenario
        @scenario_fixtures.teardown
        @scratch.remove_all
        execution = stopped ? stopped[0, 3].compact : [:pass]
        failed = records.find { _1[:status] == "failed" }
        json = { scenario_record_id: new_id("scn"), feature: scenario.uri, line: scenario.line, scenario: scenario.name,
                 environment: environment.name, status: stopped ? "failed" : "passed", started_at: started_at, finished_at: now,
                 steps: scenario.steps.zip(records).map { |line, record| step_entry(line, record) }, hooks: [] }
        json[:do] = again(scenario, environment) if failed
        held = records.sum { (_1[:claim_records] || []).count { |c| c[:outcome] == "held" } }
        broken = records.sum { (_1[:claim_records] || []).count { |c| c[:outcome] == "broken" } }
        json[:claims] = { held: held, broken: broken }
        # A scenario in which no claim on a Then line was judged says so,
        # since a pass there shows only that nothing raised.
        then_claims = scenario.steps.zip(records).select { |line, _| line_kind(line) == :then }.sum { (_2[:claim_records] || []).size }
        json[:judged_by] = "nothing" if then_claims.zero?
        json[:role] = role
        failure = if failed && role != "control"
                    { severity: "failed", code: "scenario-failed", file: scenario.uri, line: scenario.line,
                      message: "#{scenario.name}: #{failed[:error]}", do: json[:do] }
                  end
        { execution: execution, actual: stopped&.at(3), json: json, failure: failure }
      end

      # One step as run.json's scenarios[].steps[] holds it.
      def step_entry(line, record)
        entry = { line: line.line, text: line.text, step: record[:step], status: record[:status],
                  step_record_id: record[:step_record_id], record: record[:step_record_id] && "steps/#{record[:step_record_id]}" }
        return entry if record[:status] == "skipped"

        entry[:mutates] = record[:mutates]
        processes = record[:processes]
        entry[:observed] = { processes: processes&.any? ? processes.map { process_entry(_1) } : nil,
                             http: record[:http_count]&.positive? ? record[:http_count] : nil, files: nil, unmeasured: [] }
        entry[:error] = { kind: record[:error_kind], message: record[:error] } if record[:error]
        entry[:used] = record[:used] if record[:used]&.any?
        if record[:claim_records]
          entry[:claims] = record[:claim_records]
          entry[:observation] = "observed"
          entry[:attempts] = 1
        end
        entry
      end

      def process_entry(process)
        { command: [process[:command], *process[:args]], cwd: process[:cwd], exit_code: process[:exit_code],
          signal: process[:signal], duration_ms: process[:duration_ms] }.compact
      end

      def skipped(line)
        { step: Engine.matches(@steps, line.text).first&.first&.step_name, status: "skipped", step_record_id: nil }
      end

      def play_step(line, results, world)
        step, captures = Engine.matches(@steps, line.text).first
        unless step
          return { status: "failed", outcome: :broke, step_record_id: nil, error_kind: "step_error", error: %(No step definition matches "#{line.text}") }
        end

        id = new_id("step")
        dir = File.join(@dir, "steps", id)
        FileUtils.mkdir_p(dir)
        log = []
        record = { step_record_id: id, step: step.step_name, text: line.text, started_at: Time.now.utc.iso8601(3) }
        fixtures = {}
        finish = nil
        processes = []
        begin
          record[:mutates] = step.mutating?
          origins = {}
          args = bind_args(step, captures, line, results, origins, record)
          record[:args] = args
          problems = step.args.problems(args)
          if problems.any?
            record[:error_kind] = "args_invalid"
            raise TypeError, "args: #{problems.join("; ")}"
          end

          fixtures, finish = build_fixtures(step, dir, log, world)
          texts = (Pattern.new(step.pattern).texts(line.text) || {}).merge(attachment_texts(step, captures, line))
          Processes.collect(processes) { body(step, fixtures, args, line, record, results, origins, texts) }
          record[:status] ||= "passed"
        rescue StandardError => e
          record.merge!(status: "failed", outcome: :broke, error: e.message)
          record[:error_kind] ||= "step_error"
        ensure
          finish&.call
          log.concat(fixtures[:request].log) if fixtures[:request]
          record[:finished_at] = Time.now.utc.iso8601(3)
          record[:processes] = processes if processes&.any?
          record[:calls] = fixtures[:call].calls if fixtures[:call]&.calls&.any?
          record[:observed] = { http: log.size, processes: processes&.size || 0 }
          record[:http_count] = log.size
          File.write(File.join(dir, "http.jsonl"), log.map { JSON.generate(_1) }.join("\n"))
          File.write(File.join(dir, "record.json"), JSON.pretty_generate(record))
        end
        record
      end

      # A Then step's claims are judged on what it observed, or on its args
      # when it reads nothing itself; any other step runs and returns.
      def body(step, fixtures, args, line, record, results, origins, texts)
        if step.claims
          own = fixtures.slice(*step.fixtures)
          observes = step.method_defined?(:observe)
          read = -> { observes ? step.new.observe(**own, args: step.inputs.load(args)) : args }
          observed = step.poll ? Poll.new(step.poll, step.claims, args).call(record, &read) : read.()
          judged = Claims.judge(step.claims, observed, args)
          record[:claims] = judged
          # A claim on an each list has no single actual value to name.
          record[:claim_records] = step.claims.zip(judged).filter_map do |declared, result|
            RunRecord.claim(declared, result, origins, texts, observed: observes) unless declared[:each]
          end
          broken = judged.index { !_1[:holds] }
          return unless broken

          broken_record = record[:claim_records][broken]
          record.merge!(status: "failed", outcome: line_kind(line) == :then ? :fail : :broke, claim: broken,
                        broken_actual: judged[broken][:actual], error_kind: "claim_broken",
                        error: broken_record ? RunRecord.broken_message(broken_record) : "claim #{broken} broke")
        else
          value = step.new.run(**fixtures.slice(*step.fixtures), args: step.inputs.load(args))
          problems = step.returns ? step.returns.problems(value) : []
          if problems.any?
            record[:error_kind] = "result_invalid"
            raise TypeError, "returns: #{problems.join("; ")}"
          end

          if step.returns
            dropped = step.returns.dropped(value)
            record[:returns_dropped] = dropped if dropped.any?
            value = step.returns.strip(value)
          end
          results << [step, value.transform_keys(&:to_s), line.line, record[:step_record_id]]
          record[:result] = value
        end
      end

      # Captures first, then each `from` key from the nearest earlier step that
      # gave it, then a table or docstring for the one required key still open.
      # `origins` gets each from key's label, `from:<step>@<line>.<key>`, and
      # `record[:used]` each earlier step a from key read, with its result.
      def bind_args(step, captures, line, results, origins, record)
        args = captures.dup
        used = []
        step.from.each do |key, sources|
          cls, value, at_line, record_id = results.reverse_each.find { |c, _| sources.any? { _1.first == c } }
          unless cls
            record[:error_kind] = "binding_invalid"
            raise ArgumentError, %(no earlier step in this scenario gave "#{key}")
          end

          source_key = sources.find { _1.first == cls }[1].to_s
          args[key] = value.fetch(source_key)
          origins[key] = "from:#{cls.step_name}@#{at_line}.#{source_key}"
          used << { step: cls.step_name, record: "steps/#{record_id}", result: value } unless used.any? { _1[:record] == "steps/#{record_id}" }
        end
        record[:used] = used
        open = step.args.fields.map { _1.name.to_s } - args.keys
        attachment = line.table || line.doc_string
        args[open.first] = attachment if attachment && open.any?
        args
      end

      # The docstring or table a line attaches is the sentence's own text
      # for the one key it fills.
      def attachment_texts(step, captures, line)
        open = step.args.fields.map { _1.name.to_s } - captures.keys - step.from.keys
        return {} if open.empty?
        return { open.first => line.doc_string } if line.doc_string
        return { open.first => line.table.map { |row| "| #{row.join(" | ")} |" }.join("\n") } if line.table

        {}
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

      def new_id(kind) = "#{kind}-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"

      def now = Time.now.utc.iso8601(3)
    end
  end
end
