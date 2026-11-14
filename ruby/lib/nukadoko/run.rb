# frozen_string_literal: true
# rbs_inline: enabled

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
      # `world` is head for a run, or base or old for a tree's pass, which
      # writes into the head run's directory `dir`. `base` is the
      # comparison a `--base` run judges its rows by. `scenarios` are in the
      # run's order, which every round of every pass keeps; `records`, when
      # given, gets each scenario's run.json entry as one line as it ends,
      # and `rerun` is what a shuffled run's rerun lines name.
      def initialize(project, steps, scenarios, program, environments: nil, left_out: 0, out: $stdout, world: "head", dir: nil, base: nil, env_flags: [],
                     repeat: 1, concurrency: 1, order: Order::FILE, records: nil, rerun: nil)
        @project = project
        @steps = steps
        @scenarios = scenarios
        @program = Program.new(program)
        @environments = environments || @program.environments
        @left_out = left_out
        @out = out
        @world = world
        @base = base
        @env_flags = env_flags
        @repeat = repeat
        @concurrency = concurrency
        @incomplete = []
        @world_entries = []
        @order = order
        @records = records
        @rerun = rerun || { targets: [], tags: [], whole_files: [] }
        @id = dir ? File.basename(dir) : new_id("run")
        @dir = dir || File.join(project, ".nukadoko", "runs", @id)
      end

      def call
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        @started_at = now
        @commit = RunRecord.commit(@project)
        # Said before any scenario, so a run a signal stops still names its seed.
        @out.puts "order #{Order.text(@order)}" unless @order[:kind] == "file"
        executions, cells = pass
        tree_cells = {}
        if @base
          begin
            trees = TreePasses.new(@base, @scenarios, cells, @environments, @dir, @out)
            tree_cells = trees.call(executions)
            @world_entries.concat(trees.worlds)
          ensure
            @base.cleanup
          end
        end
        finish(executions, cells, tree_cells)
      end

      # One pass of a tree: each scenario in the one environment, as base or
      # old, its executions and its cell.
      def tree_pass
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        executions, cells = pass
        @scenarios.map do |scenario|
          { feature: scenario.uri, line: scenario.line, cell: cells[scenario].first,
            executions: executions.select { _1[:json][:feature] == scenario.uri && _1[:json][:line] == scenario.line }.map { _1[:json] } }
        end
      end

      # Each world this run started, as run.json's worlds holds it.
      attr_reader :world_entries

      def role_of(scenario, environment) = Table.role(Table.condition_tags(scenario.tags), environment.conditions)

      private

      def pass
        @base_urls = {}
        executions = []
        cells = Hash.new { |h, k| h[k] = [] }
        @environments.each do |environment|
          @out.puts @world == "head" ? "environment #{environment.name}" : "#{@world} #{environment.name}"
          world_dir = File.join(@dir, "worlds", @world == "head" ? environment.name : "#{environment.name}@#{@world}")
          FileUtils.mkdir_p(world_dir)
          world = @program.start(environment, world_dir, @project)
          @program_log = world.log_path && Trace::Log.new(world.log_path, world.trace_prefix)
          @base_urls[environment.name] = world.base_url
          roles = @scenarios.to_h { [_1, @world == "head" ? role_of(_1, environment) : "required"] }
          runs = Hash.new { |h, k| h[k] = [] }
          ran = lambda do |scenario, execution|
            runs[scenario] << execution
            executions << execution
            @records&.puts JSON.generate(execution[:json])
          end
          # Each control that broke a Then runs again, one round at a time,
          # until it has broken the same claim at the same line --proof-runs
          # times or a run disagrees.
          due = -> { @scenarios.select { proving?(roles[_1], runs[_1]) } }
          if @concurrency > 1
            play_in_workers(environment, roles, world, due, ran)
          else
            @process_fixtures = FixtureCache.new
            @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}))
            play_one = ->(scenario) { ran.(scenario, play(scenario, environment, roles[scenario], world)) }
            # The whole selection once, then again, so a failure that depends
            # on what ran before it meets the same neighbours every round.
            @repeat.times { @scenarios.each(&play_one) }
            until (round = due.()).empty?
              round.each(&play_one)
            end
          end
          @scenarios.each { cells[_1] << cell(runs[_1], environment, roles[_1], _1) }
        ensure
          @browser&.close
          @process_fixtures&.teardown
          world&.stop
          @world_entries << world_entry(environment, world, world_dir, (runs&.values || []).flatten) if world && @program.file?
          @browser = @process_fixtures = @program_log = nil
        end
        [executions, cells]
      end

      # A stopped world as run.json names it. The lines of the program's log
      # that came after their step's record was read go beside that record,
      # and its run.json entry names them.
      def world_entry(environment, world, world_dir, executions)
        entry = { name: environment.name, tree: @world, url: world.base_url, commands: world.commands, timings: world.timings,
                  log: world.log_path && File.join("worlds", File.basename(world_dir), "program.log"), error: nil }
        return entry unless world.base_url
        return entry.merge(program_log: nil) unless world.log_path

        steps = executions.flat_map { _1[:json][:steps] || [] }.select { _1.dig(:observed, :program_log) }
        traced = steps.to_h { |step| [step[:observed][:program_log][:trace_id], [step[:observed][:program_log][:lines], File.join(@dir, step[:record])]] }
        found = Trace::Log.new(world.log_path, world.trace_prefix).late(traced)
        steps.each do |step|
          late = found[:late][step[:observed][:program_log][:trace_id]]
          step[:program_log_late] = late if late
        end
        sum = ->(key) { steps.sum { _1[:observed][:program_log][key] } }
        entry.merge(program_log: { stamped: sum.(:stamped), lines: sum.(:lines), late: found[:late].values.sum { _1[:lines] }, tagged: found[:tagged] })
      end

      # Under --concurrency the files go to worker processes in the run's
      # order, round-robin, and each worker plays its own files --repeat
      # times. A file whose Feature line is @nukadoko:serial runs after
      # them, alone, and each round of proof runs is one worker of its own.
      # The parent keeps the world each worker reaches, and takes each
      # execution as it arrives.
      def play_in_workers(environment, roles, world, due, ran)
        files = @scenarios.group_by(&:uri).values
        parallel, serial = files.partition { !_1.first.serial }
        buckets = Array.new([@concurrency, parallel.size].min) { [] }
        parallel.each_with_index { |file, i| buckets[i % buckets.size] << file } unless buckets.empty?
        groups = buckets.map(&:flatten)
        unplayed = workers(groups.map { |group| @repeat.times.flat_map { group } }, environment, roles, world, ran)
        serial.each { |file| unplayed += workers([@repeat.times.flat_map { file }], environment, roles, world, ran) }
        until (round = due.()).empty?
          break unless workers([round], environment, roles, world, ran).empty?
        end
        return if unplayed.empty?

        where = unplayed.uniq.sort.map { @environments.size > 1 ? "#{_1} (#{environment.name})" : _1 }
        @incomplete << { severity: "failed", code: "run-incomplete",
                         message: "A worker exited without writing any record for: #{where.join(", ")}. This run is incomplete and cannot be treated as a pass" }
      end

      # Each list is one worker's scenarios in the order it plays them. A
      # worker sends each line it prints and each execution down a pipe of
      # its own, one Marshal frame at a time, so no line or record is ever
      # spliced from two workers. Returns the files a worker that failed
      # left without any execution.
      def workers(lists, environment, roles, world, ran)
        live = lists.each_with_index.map do |list, index|
          reader, writer = IO.pipe
          pid = fork do
            reader.close
            exit!(play_as_worker(index + 1, list, environment, roles, world, writer))
          end
          writer.close
          { pid: pid, reader: reader, list: list, played: Set.new }
        end
        by_key = @scenarios.to_h { [[_1.uri, _1.line], _1] }
        until (open = live.reject { _1[:done] }).empty?
          IO.select(open.map { _1[:reader] })[0].each do |reader|
            worker = open.find { _1[:reader] == reader }
            kind, *value = Marshal.load(reader)
            if kind == :line then @out.puts value.first
            else
              value[2].each { @out.puts _1 }
              scenario = by_key.fetch(value[0])
              worker[:played] << scenario.uri
              ran.(scenario, value[1])
            end
          rescue EOFError
            reader.close
            worker[:done] = true
            worker[:status] = Process.wait2(worker[:pid])[1]
          end
        end
        live.reject { _1[:status].success? }.flat_map { |worker| worker[:list].map(&:uri).uniq - worker[:played].to_a }
      end

      def play_as_worker(number, list, environment, roles, world, pipe)
        @worker = number
        @out = WorkerOut.new(pipe)
        @records = nil
        @process_fixtures = FixtureCache.new
        @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}))
        list.each do |scenario|
          execution = play(scenario, environment, roles[scenario], world)
          Marshal.dump([:execution, [scenario.uri, scenario.line], execution, @out.take], pipe)
        end
        0
      rescue Exception => e # rubocop:disable Lint/RescueException
        Marshal.dump([:line, "worker #{number} stopped: #{e.class}: #{e.message}"], pipe) rescue nil
        1
      ensure
        @browser&.close
        @process_fixtures&.teardown
        pipe.close
      end

      # A worker's progress: the line that a scenario starts goes to the
      # parent at once, and the scenario's other lines go with its
      # execution, so one scenario's lines are never split by another's.
      class WorkerOut
        def initialize(pipe)
          @pipe = pipe
          @held = []
        end

        def puts(text = "")
          text = text.to_s
          text.start_with?("scenario start  ") ? Marshal.dump([:line, text], @pipe) : @held << text
        end

        def take = @held.slice!(0..)
      end

      # A head control and a base cell stand where the behaviour is absent,
      # so a Then failing there the same way in each proof run is proof.
      def proving?(role, runs)
        absent = @world == "base" || (@world == "head" && role == "control")
        absent && runs.size < Table.proof_runs && runs.all? { _1[:execution].first == :fail } && runs.map { _1[:execution] }.uniq.size == 1
      end

      # A cell is what one scenario's executions in one environment came to;
      # a cell whose first execution broke a claim names it and what it read.
      # Its conditions are the ones the row's tags name, as the environment
      # gives them.
      def cell(runs, environment, role, scenario)
        executions = runs.map { _1[:execution] }
        cell = Table.cell(executions)
        entry = { world: @world, environment: environment.name, role: role, conditions: Table.conditions_of(scenario.tags, environment.conditions),
                  outcome: cell[:outcome], line: cell[:line], runs: cell[:runs] }.compact
        if cell[:outcome] == "fail"
          entry[:claim] = executions.first[2]
          entry[:actuals] = runs.map { { value: _1[:actual] } }
        end
        entry
      end

      # run.json is the --json envelope as a file: the commit and worlds the
      # run judged, the counts, each execution, and the verdict table.
      # `tree_cells` holds each row's base and old cells, by its scenario,
      # under `--base`; each row is judged with what changed since the base.
      def finish(executions, cells, tree_cells = {})
        rows = @scenarios.map do |scenario|
          change = @base&.changes&.[](Criteria.key(scenario.uri, scenario.line))
          row_cells = cells[scenario] + tree_cells.fetch(scenario, [])
          verdict, reason = RunRecord.judge_row(row_cells, context_of(scenario, change, executions))
          row = { feature: scenario.uri, line: scenario.line, name: scenario.name, change: change&.dig(:change) }
          row[:renamed_from] = change[:renamed_from] if change&.dig(:renamed_from)
          row[:retagged] = true if change&.dig(:retagged)
          row.merge(conditions: Table.row_tags(scenario.tags), cells: row_cells, verdict: verdict, reason: reason)
        end
        rows.sort_by! { [_1[:feature], _1[:line]] }
        rows.concat(removed_rows) if @base
        scenarios = executions.map { _1[:json] }
        worlds = %w[head base old].flat_map do |world|
          environments = world == "old" ? (@base&.old_environments || @environments) : @environments
          environments.map(&:name).select { |name| world == "head" || rows.any? { |row| row[:cells].any? { _1[:world] == world && _1[:environment] == name } } }
                      .map { { world: world, environment: _1 } }
        end
        judged = @base ? judged_findings(rows) : []
        { run_id: @id, run_dir: File.join(".nukadoko/runs", @id), started_at: @started_at, finished_at: now, commit: @commit,
          environments: @environments.map { environment_entry(_1) }, worlds: @world_entries, order: @order,
          counts: RunRecord.counts(scenarios.reject { _1[:world] }), scenarios: scenarios,
          table: { base: @base && { ref: @base.ref, commit: @base.commit }, mapping_changed: @base&.mapping&.dig(:changed),
                   mapping_changes: @base&.mapping_changes, **(@base ? { judgments_changed: [] } : {}),
                   worlds: worlds, rows: rows, left_out: @left_out, proof_runs: Table.proof_runs },
          failures: executions.filter_map { _1[:failure] } + judged + @incomplete,
          passed: @incomplete.empty? && rows.none? { Summary::RED.include?(_1[:verdict]) } }
      end

      # What `--base` knows of one row: its change, whether it carries
      # @held, whether the mapping changed, whether its tags or its name or
      # file changed, and whether its passing executions judged no claim in
      # Then position.
      def context_of(scenario, change, executions)
        return nil unless change

        no_claim = executions.any? do |execution|
          json = execution[:json]
          json[:feature] == scenario.uri && json[:line] == scenario.line && !json[:world] && json[:role] == "required" &&
            json[:status] == "passed" && json[:judged_by] == "nothing"
        end
        { change: change[:change], held: scenario.tags.include?(Criteria::HELD), mapping_changed: @base.mapping[:changed],
          retagged: change[:retagged] == true, renamed: !change[:renamed_from].nil?, then_judges_no_claim: no_claim ? "nothing" : nil }
      end

      def removed_rows
        @base.removed.sort_by { [_1.feature, _1.line] }.map do |criterion|
          { feature: criterion.feature, line: criterion.line, name: criterion.name, change: "removed",
            conditions: Table.row_tags(criterion.tags), cells: [], verdict: "removed",
            reason: "the base holds this criterion, and head no longer does", lines: criterion.lines }
        end
      end

      # A finding for each unproven and moved row, which has no failed
      # execution to carry one, with the command that judges it again
      # against the commit the run compared with.
      def judged_findings(rows)
        rows.filter_map do |row|
          next unless %w[unproven moved].include?(row[:verdict])

          command = ["nuka", "run", "#{row[:feature]}:#{row[:line]}", "--base", @base.commit, *@env_flags].map { Selection.shell_word(_1) }.join(" ")
          { severity: "failed", code: row[:verdict] == "unproven" ? "criterion-unproven" : "criterion-moved", file: row[:feature], line: row[:line],
            message: %(Scenario "#{row[:name]}" is #{row[:verdict]}: it #{row[:reason]}), do: command }
        end
      end

      def environment_entry(environment)
        { name: environment.name, conditions: environment.conditions.empty? ? nil : environment.conditions,
          target_version: nil, base_url: @base_urls[environment.name] }.compact.merge(target_version: nil, base_url: @base_urls[environment.name])
      end

      # Where a scenario's run starts again: its line, and its environment
      # unless that is the only one a run without --env would start.
      # In a shuffled order what ran before a scenario is part of what it
      # met, so the line names those scenarios, then it, with the order and
      # the run's --env flags. Under --repeat no one part of the order ran
      # before it, so the line is the run's own targets and flags.
      def again(scenario, environment)
        if @order[:kind] == "file"
          env = @environments.map(&:name) == ["default"] ? "" : " --env #{environment.name}"
          return "nuka run #{scenario.uri}:#{scenario.line}#{env}"
        end

        # Under --concurrency, what ran before it ran in other workers too.
        words = if @repeat > 1 || @concurrency > 1
                  [*@rerun[:targets], *@rerun[:tags], *Order.flags(@order), *(["--repeat", @repeat.to_s] if @repeat > 1),
                   *(["--concurrency", @concurrency.to_s] if @concurrency > 1), *@env_flags]
                else [*Order.replay_targets(@scenarios, @rerun[:whole_files], scenario), *Order.flags(@order), *@env_flags]
                end
        ["nuka", "run", *words].map { Selection.shell_word(_1) }.join(" ")
      end

      def play(scenario, environment, role, world)
        name = "#{scenario.uri}:#{scenario.line}  #{scenario.name}"
        @out.puts "scenario start  worker #{@worker}  #{name}" if @worker
        @out.puts "scenario  #{name}#{role == "control" ? "  (control)" : ""}"
        started_at = now
        results = []
        stopped = nil #: Array[untyped]?
        @scratch = Scratch.new
        @scenario_fixtures = FixtureCache.new
        scenario_record_id = new_id("scn")
        @step_file = lambda do |record|
          RunRecord.step_file(record, environment: environment.name, world_name: @program.file? ? environment.name : nil, run_id: @id,
                                      scenario_record_id: scenario_record_id, evidence_dir: File.join(".nukadoko", "runs", @id, "steps", record[:step_record_id]))
        end
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
        execution = stopped ? stopped[0, 3].to_a.compact : [:pass]
        failed = records.find { _1[:status] == "failed" }
        json = { scenario_record_id: scenario_record_id, feature: scenario.uri, line: scenario.line, scenario: scenario.name,
                 environment: environment.name, status: stopped ? "failed" : "passed", started_at: started_at, finished_at: now,
                 steps: scenario.steps.zip(records).map { |line, record| step_entry(line, record) }, hooks: [] } #: Hash[Symbol, untyped]
        json[:do] = again(scenario, environment) if failed && role != "control"
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
        { execution: execution, actual: stopped && stopped[3], json: json, failure: failure }
      end

      # One step as run.json's scenarios[].steps[] holds it.
      def step_entry(line, record)
        entry = { line: line.line, text: line.text, step: record[:step], status: record[:status],
                  step_record_id: record[:step_record_id], record: record[:step_record_id] && "steps/#{record[:step_record_id]}" }
        return entry if record[:status] == "skipped"

        entry[:mutates] = record[:mutates]
        processes = record[:processes]
        # run.json keeps the record's observed without file content, so it stays small.
        entry[:observed] = { processes: processes&.any? ? processes : nil, http: record[:http_count]&.positive? ? record[:http_count] : nil,
                             files: record[:files]&.map { _1.except(:content) }, unmeasured: [],
                             **(record.key?(:program_log) ? { program_log: record[:program_log] } : {}) }
        entry[:error] = { kind: record[:error_kind], message: record[:error] } if record[:error]
        # Only a failed step names what it read: a reader then sees the value it broke on.
        entry[:used] = record[:used] if record[:used]&.any? && record[:status] == "failed"
        if record[:claim_records]
          entry[:claims] = record[:claim_records]
          entry[:observation] = record[:observation] || "observed"
          entry.merge!(RunRecord.poll_fields(record).except(:readings), **RunRecord.page_fields(record, File.join("steps", record[:step_record_id].to_s)))
        end
        entry
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
        record = { step_record_id: id, step: step.step_name, text: line.text, started_at: Time.now.utc.iso8601(3) }
        origins = {}
        execute(step, record, dir, world, then_line: line_kind(line) == :then, at_line: line.line, results: results, origins: origins) do
          args = bind_args(step, captures, line, results, origins, record)
          [args, (Pattern.new(step.pattern).texts(line.text) || {}).merge(attachment_texts(step, captures, line))]
        end
      end

      public

      # One step alone, as `nuka do` runs it: its args given on the command
      # line or by earlier records (`origins` says which), in a world
      # started for this one execution, its evidence in this run's
      # directory, which is the record's own.
      def do_step(step, args, origins, texts, environment)
        FileUtils.mkdir_p(@dir)
        world = @program.start(environment, @dir, @project)
        @program_log = world.log_path && Trace::Log.new(world.log_path, world.trace_prefix)
        @scratch = Scratch.new
        @scenario_fixtures = FixtureCache.new
        @process_fixtures = FixtureCache.new
        @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}))
        record = { step_record_id: @id, step: step.step_name, started_at: now }
        execute(step, record, @dir, world, then_line: true, at_line: nil, results: [], origins: origins) { [args, texts] }
      ensure
        @browser&.close
        @scenario_fixtures&.teardown
        @process_fixtures&.teardown
        @scratch&.remove_all
        world&.stop
      end

      private

      # Runs one step whose args the block binds, and writes its record and
      # HTTP log into `dir`.
      #: (singleton(Step), Hash[Symbol, untyped], String, World, then_line: bool, at_line: Integer?, results: Array[untyped], origins: Hash[String, String]) { () -> [Hash[String, untyped], Hash[String, String]] } -> Hash[Symbol, untyped]
      def execute(step, record, dir, world, then_line:, at_line:, results:, origins:)
        FileUtils.mkdir_p(dir)
        log = []
        fixtures = {}
        finish = nil #: Proc?
        processes = []
        scratch_dirs = @scratch&.dirs || []
        scratch_before = @scratch&.snapshot || {}
        # A world with a URL is one the step's requests can be traced into.
        boundary = world.base_url && Trace::Boundary.new(Trace.new_id(world.trace_prefix), world.base_url)
        begin
          record[:mutates] = step.mutating?
          args, texts = yield
          record[:args] = args
          problems = step.args.problems(args)
          if problems.any?
            record[:error_kind] = "args_invalid"
            raise TypeError, "args: #{problems.join("; ")}"
          end

          @browser&.step = { step_record_id: record[:step_record_id], step: record[:step], line: at_line }
          @browser&.begin_step
          Trace.within(boundary) do
            fixtures, finish = build_fixtures(step, dir, log, world, record)
            HttpRecording.collect(log) do
              Processes.collect(processes) { body(step, fixtures, args, [then_line, at_line], record, results, origins, texts) }
            end
          end
          record[:page_view] = @browser.judged(dir, record[:step_record_id]) if step.claims && fixtures[:page] && record[:observation] != "unobserved"
          record[:status] ||= "passed"
        rescue StandardError => e
          record.merge!(status: "failed", outcome: :broke, error: e.message)
          record[:error_kind] ||= "step_error"
        ensure
          @browser&.step = nil
          finish&.call
          log.concat(fixtures[:request].log) if fixtures[:request]
          # A world at a URL has a log nukadoko does not read.
          record[:program_log] = @program_log&.slice(dir, boundary) if boundary
          record[:finished_at] = Time.now.utc.iso8601(3)
          # Each process's output is a file of the step's own, named by its number.
          processes.each.with_index(1) do |process, n|
            output = process.delete(:output) || {}
            %i[stdout stderr stdin].each do |stream|
              next if output[stream].to_s.empty?

              File.write(File.join(dir, "process-#{n}.#{stream}.txt"), output[stream])
              process[stream] = "process-#{n}.#{stream}.txt"
            end
          end
          record[:processes] = processes if processes&.any?
          if @scratch
            changes = @scratch.changes(scratch_before)
            record[:files] = changes if changes.any?
            made = @scratch.dirs - scratch_dirs
            record[:scratch] = made if made.any?
          end
          record[:calls] = fixtures[:call].calls if fixtures[:call]&.calls&.any?
          # A page's own traffic is in http.jsonl and the trace, not counted as the step's.
          record[:http_count] = log.count { _1[:via] != "page" }
          File.write(File.join(dir, "http.jsonl"), "#{log.map { JSON.generate(_1) }.join("\n")}\n") if log.any?
          record[:http_file] = log.any?
          if (traced = TraceActions.read(File.join(dir, "trace.zip")))
            record[:trace] = "trace.zip"
            record[:actions] = traced[:actions] if traced[:actions].any?
            record[:actions_truncated] = traced[:truncated] if traced[:truncated]
          end
          measure(step, record, dir) if record[:claim_records]
          File.write(File.join(dir, "record.json"), JSON.pretty_generate(@step_file ? @step_file.(record) : record))
        end
        record
      end

      # A Then step's claims are judged on what it observed, or on its args
      # when it reads nothing itself; any other step runs and returns.
      def body(step, fixtures, args, position, record, results, origins, texts)
        then_line, at_line = position
        if step.claims
          own = fixtures.slice(*step.fixtures)
          observes = step.method_defined?(:observe)
          # A claim's actual that starts with a from key reads the value an
          # earlier step returned, which wins over a key observe returns
          # under the same name.
          from_values = args.transform_keys(&:to_s).slice(*step.from.keys.map(&:to_s))
          read = lambda do
            next args unless observes

            observed = step.new.observe(**own, args: step.inputs.load(args))
            observed.is_a?(Hash) ? observed.transform_keys(&:to_s).merge(from_values) : observed
          end
          # A reading with a page open is timed, so the record can say what the page had received by then.
          read = (plain = read; -> { @browser.reading(&plain) }) if own[:page]
          observed = begin
            step.poll ? Poll.new(step.poll, step.claims, args).call(record, &read) : read.()
          rescue StandardError => e
            raise unless observes && !step.poll

            # observe failing is no claim breaking: nothing was read to judge.
            record[:observation] = "unobserved"
            record[:claim_records] = step.claims.reject { _1[:each] }.map { RunRecord.unobserved_claim(_1, origins, texts, patterns: [step.pattern].compact) }
            record[:error_kind] = "unobserved"
            raise e.class, "the step observed nothing, so no claim was judged: #{e.message}"
          end
          judged = Claims.judge(step.claims, observed, args)
          record[:claims] = judged
          # The value each claim read before its view, for `measured`.
          record[:raw_actuals] = step.claims.map do |declared|
            next nil if declared[:each]

            # Under a view the raw value is the text the view read; else the value at `at`.
            read = Claims.read(observed, declared[:actual])
            declared[:view] ? read : Claims.dig(read, declared[:at])
          rescue StandardError
            nil
          end
          patterns = [step.pattern].compact
          record[:claim_records] = step.claims.zip(judged).map do |declared, result|
            if declared[:each]
              RunRecord.each_claim(declared, observed, args, origins, texts, observed_from: observes && !from_values.key?(declared[:actual].to_s.split(".").first), patterns: patterns)
            else
              RunRecord.claim(declared, result, origins, texts, observed: observes && !from_values.key?(declared[:actual].to_s.split(".").first), patterns: patterns)
            end
          end
          broken = record[:claim_records].index { _1[:outcome] != "held" }
          return unless broken

          message = RunRecord.broken_message(record[:claim_records])
          first, *rest = message.split("\n", -1)
          message = ["#{first}#{RunRecord.poll_end(step, record)}", *rest].join("\n")
          record.merge!(status: "failed", outcome: then_line ? :fail : :broke, claim: broken,
                        broken_actual: judged[broken][:actual], error_kind: "claim_broken", error: message)
        else
          value = step.new.run(**fixtures.slice(*step.fixtures), args: step.inputs.load(args))
          problems = step.returns ? step.returns.problems(value) : []
          if problems.any?
            record[:error_kind] = "result_invalid"
            raise TypeError, "returns: #{problems.join("; ")}"
          end

          record[:returns_dropped] = step.returns ? step.returns.drops(value) : []
          value = step.returns.strip(value) if step.returns
          results << [step, value.transform_keys(&:to_s), at_line, record[:step_record_id]]
          record[:result] = value
        end
      end

      # Captures first, then each `from` key from the nearest earlier step that
      # gave it, then a table or docstring for the one required key still open.
      # `origins` gets each from key's label, `from:<step>@<line>.<key>`, and
      # `record[:used]` each earlier step a from key read, with its result.
      # Each claim record's `measured`: the channel that holds the raw value
      # it read, in the record of the step a `from` value came from, or in
      # its own; and an expected value an earlier step gave, the same way.
      def measure(step, record, dir)
        own = record[:step_record_id]
        own_channels = Measured.channels(dir, { processes: record[:processes], files: record[:files] }, record[:http_count].to_i.positive? ? "http.jsonl" : nil)
        cache = {}
        channels_of = lambda do |id|
          next own_channels if id == own

          cache[id] ||= begin
            found = [File.join(@dir, "steps", id), File.join(@project, ".nukadoko", "do", id)].find { File.exist?(File.join(_1, "record.json")) }
            other = found && JSON.parse(File.read(File.join(found, "record.json")), symbolize_names: true)
            other ? Measured.channels(found, other[:observed] || {}, other.dig(:evidence, :http)) : [{ channel: "record", unknown: true }]
          end
        end
        from_of = ->(key) { (origin = (record[:args_origin] || {})[key.to_s.split(".").first]).is_a?(Hash) ? origin.dig(:from, :step_record_id) : nil }
        step.claims.zip(record[:claim_records], record[:raw_actuals] || []).each do |declared, claim, raw|
          next if claim.nil? || claim[:outcome] == "unobserved" || declared[:each]

          measured = Measured.channel_for(from_of.(declared[:actual]) || own, raw, channels_of)
          claim[:measured] = measured
          key = declared[:expected].is_a?(String) ? declared[:expected] : declared[:expected].is_a?(Hash) && declared[:expected][:from]
          source = declared[:expected].is_a?(Hash) && declared[:expected].key?(:observe) ? own : key && from_of.(key)
          next unless source && claim.key?(:expected)

          # The expected side's channel comes before the actual's, as the TypeScript engine writes it.
          claim.delete(:measured)
          claim.merge!(expected_measured: Measured.channel_for(source, claim[:expected], channels_of, measured), measured: measured)
        end
        record.delete(:raw_actuals)
      end

      def bind_args(step, captures, line, results, origins, record)
        args = captures.dup
        record[:args_origin] = captures.keys.to_h { [_1, "capture"] }
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
          record[:args_origin][key] = { from: { step_record_id: record_id, step: cls.step_name, key: source_key } }
          used << { step: cls.step_name, record: "steps/#{record_id}", result: value } unless used.any? { _1[:record] == "steps/#{record_id}" }
        end
        record[:used] = used
        open = step.args.fields.map { _1.name.to_s } - args.keys
        attachment = line.table || line.doc_string
        if attachment && open.any?
          args[open.first] = attachment
          record[:args_origin][open.first] = line.table ? "table" : "docstring"
        end
        # In the order the args schema declares, as the record shows them.
        rank = step.args.fields.each_with_index.to_h { [_1.name.to_s, _2] }
        record[:args_origin] = record[:args_origin].sort_by { |key, _| rank.fetch(key.to_s, rank.size) }.to_h
        args.sort_by { |key, _| rank.fetch(key.to_s, rank.size) }.to_h
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
        deps = fixture.dependencies.to_h do |dep|
          case dep
          when :baseURL then [dep, world.base_url]
          when :scratch then [dep, @scratch]
          else [dep, project_fixture(dep, world, [*chain, name])]
          end
        end
        return cache[name].tap { note_fixture(name, fixture.scope, nil, nil) } if cache.key?(name)

        at = now
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        cache.build(fixture, deps).tap { note_fixture(name, fixture.scope, Request.since(started), at) }
      end

      # Each project fixture a step's bag touched, once, as the step record
      # lists it: built here with its setup time, or reused from its scope.
      def note_fixture(name, scope, setup_ms, at)
        return if @fixture_usage.nil? || @fixture_usage.any? { _1[:name] == name.to_s }

        @fixture_usage << { name: name.to_s, scope: scope.to_s, reused: setup_ms.nil?, setup_ms: setup_ms, at: at }.compact
      end

      def build_fixtures(step, dir, log, world, record)
        finish = nil
        @fixture_usage = []
        fixtures = (step.bag - [:call]).to_h do |name|
          case name
          when :request then [name, Request.new(world.base_url)]
          when :baseURL then [name, world.base_url]
          when :env then [name, world.env]
          when :requireEnv then [name, ->(key) { world.env.fetch(key.to_s) { raise %(requireEnv("#{key}"): the world's env has no #{key}) } }]
          when :scratch then [name, @scratch]
          when :page
            page, finish = @browser.page_for(dir, log)
            [name, page]
          else [name, project_fixture(name, world, [])]
          end
        end
        fixtures[:call] = Caller.new(step, fixtures) if step.fixtures.include?(:call)
        record[:fixtures] = @fixture_usage if @fixture_usage.any?
        @fixture_usage = nil
        [fixtures, finish]
      end

      def new_id(kind) = "#{kind}-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"

      def now = Time.now.utc.iso8601(3)
    end
  end
end
