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
      # writes into the head run's directory `dir`, and reads its env files
      # from `head`'s root, with head's secrets as well as its own. `base` is the
      # comparison a `--base` run judges its rows by. `scenarios` are in the
      # run's order, which every round of every pass keeps; `records`, when
      # given, gets each scenario's run.json entry as one line as it ends,
      # and `rerun` is what a shuffled run's rerun lines name.
      #: (String, Array[singleton(Step)], Array[Scenario], Hash[Symbol, untyped], ?environments: Array[Environment]?, ?left_out: Integer, ?out: untyped, ?world: String, ?dir: String?, ?base: Base?, ?env_flags: Array[String], ?repeat: Integer, ?concurrency: Integer, ?order: Hash[Symbol, untyped], ?records: IO?, ?rerun: untyped, ?walk: WalkFiles::Handle?, ?head: Hash[Symbol, untyped]?) -> void
      def initialize(project, steps, scenarios, program, environments: nil, left_out: 0, out: $stdout, world: "head", dir: nil, base: nil, env_flags: [],
                     repeat: 1, concurrency: 1, order: Order::FILE, records: nil, rerun: nil, walk: nil, head: nil)
        @head = head
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
        # Under --step, the walk this run's one scenario pauses for.
        @walk = walk
        @id = dir ? File.basename(dir) : new_id("run")
        @dir = dir || File.join(project, ".nukadoko", "runs", @id)
      end

      #: () -> Hash[Symbol, untyped]
      def call
        # An env file that cannot be read stops the run before anything starts.
        @environments.each { read_env(_1) }
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        @started_at = now
        write_sources
        @commit = RunRecord.commit(@project)
        # Said before any scenario, so a run a signal stops still names its seed.
        @out.puts "order #{Order.text(@order)}" unless @order[:kind] == "file"
        executions, cells = pass
        tree_cells = {}
        if @base
          begin
            trees = TreePasses.new(@base, @scenarios, cells, @environments, @dir, @out, ->(scenario) { Run.then_judged_by(scenario, executions) }, head_root: @project)
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
      #: () -> Array[Hash[Symbol, untyped]]
      def tree_pass
        FileUtils.mkdir_p(File.join(@dir, "steps"))
        executions, cells = pass
        @scenarios.map do |scenario|
          { feature: scenario.uri, line: scenario.line, cell: cells[scenario].first,
            executions: executions.select { _1[:json][:feature] == scenario.uri && _1[:json][:line] == scenario.line }.map { _1[:json] } }
        end
      end

      # Each world this run started, as run.json's worlds holds it.
      attr_reader :world_entries #: Array[Hash[Symbol, untyped]]

      #: (Scenario, Environment) -> String
      def role_of(scenario, environment) = Table.role(Table.condition_tags(scenario.tags), environment.conditions)

      private

      #: () -> [Array[Hash[Symbol, untyped]], Hash[Scenario, Array[Hash[Symbol, untyped]]]]
      def pass
        @base_urls = {}
        executions = []
        cells = Hash.new { |h, k| h[k] = [] }
        # Each scenario line is numbered across every environment and
        # --repeat round, as the TypeScript engine numbers it; a proof run
        # has a line of its own, so it is never one scenario more.
        @played = 0
        @to_play = @scenarios.size * @repeat * @environments.size
        @environments.each do |environment|
          # One environment needs no line of its own: every scenario is in it.
          if @world != "head" then @out.puts "#{@world} #{environment.name}"
          elsif @environments.size > 1 then @out.puts "environment #{environment.name}"
          end
          world_dir = File.join(@dir, "worlds", @world == "head" ? environment.name : "#{environment.name}@#{@world}")
          FileUtils.mkdir_p(world_dir)
          read_env(environment)
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
            play_in_workers(environment, roles, world, due, ran, runs)
          else
            @process_fixtures = FixtureCache.new
            @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}), secrets: -> { secrets })
            play_one = lambda do |scenario|
              @out.puts boundary(scenario.uri, scenario.line, scenario.name, roles[scenario])
              ran.(scenario, play(scenario, environment, roles[scenario], world))
            end
            # The whole selection once, then again, so a failure that depends
            # on what ran before it meets the same neighbours every round.
            @repeat.times { @scenarios.each(&play_one) }
            until (round = due.()).empty?
              round.each do |scenario|
                @out.puts proof_boundary(scenario.uri, scenario.line, scenario.name, environment.name, runs[scenario].size + 1)
                ran.(scenario, play(scenario, environment, roles[scenario], world))
              end
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
      #: (Environment, World, String, Array[Hash[Symbol, untyped]]) -> Hash[Symbol, untyped]
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
      #: (Environment, Hash[Scenario, String], World, ^() -> Array[Scenario], ^(Scenario, Hash[Symbol, untyped]) -> void, Hash[Scenario, Array[Hash[Symbol, untyped]]]) -> void
      def play_in_workers(environment, roles, world, due, ran, runs)
        files = @scenarios.group_by(&:uri).values
        parallel, serial = files.partition { !_1.first.serial }
        buckets = Array.new([@concurrency, parallel.size].min) { [] }
        parallel.each_with_index { |file, i| buckets[i % buckets.size] << file } unless buckets.empty?
        groups = buckets.map(&:flatten)
        # The parent numbers a scenario's line when its execution arrives:
        # the Nth to finish, since workers end in no fixed order.
        line_for = lambda do |scenario, proof|
          proof ? proof_boundary(scenario.uri, scenario.line, scenario.name, environment.name, runs[scenario].size + 1)
                : boundary(scenario.uri, scenario.line, scenario.name, roles[scenario])
        end
        main = ->(scenario) { line_for.(scenario, false) }
        unplayed = workers(groups.map { |group| @repeat.times.flat_map { group } }, environment, roles, world, ran, main)
        serial.each { |file| unplayed += workers([@repeat.times.flat_map { file }], environment, roles, world, ran, main) }
        until (round = due.()).empty?
          break unless workers([round], environment, roles, world, ran, ->(scenario) { line_for.(scenario, true) }).empty?
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
      #: (Array[Array[Scenario]], Environment, Hash[Scenario, String], World, ^(Scenario, Hash[Symbol, untyped]) -> void, ^(Scenario) -> String) -> Array[String]
      def workers(lists, environment, roles, world, ran, line_for)
        live = lists.each_with_index.map do |list, index|
          reader, writer = IO.pipe
          pid = fork do
            reader.close
            exit!(play_as_worker(index + 1, list, environment, roles, world, writer))
          end
          writer.close
          worker = { pid: pid, reader: reader, list: list, played: Set.new } #: Hash[Symbol, untyped]
          worker
        end
        by_key = @scenarios.to_h { [[_1.uri, _1.line], _1] }
        until (open = live.reject { _1[:done] }).empty?
          IO.select(open.map { _1[:reader] })&.first.to_a.each do |reader|
            worker = open.find { _1[:reader] == reader } #: Hash[Symbol, untyped]
            kind, *value = Marshal.load(reader)
            if kind == :line then @out.puts value.first
            else
              scenario = by_key.fetch(value[0])
              @out.puts line_for.(scenario)
              value[2].each { @out.puts _1 }
              worker[:played] << scenario.uri
              ran.(scenario, value[1])
            end
          rescue EOFError
            reader.close
            ended = open.find { _1[:reader] == reader } #: Hash[Symbol, untyped]
            ended[:done] = true
            ended[:status] = Process.wait2(ended[:pid])[1]
          end
        end
        live.reject { _1[:status].success? }.flat_map { |worker| worker[:list].map(&:uri).uniq - worker[:played].to_a }
      end

      #: (Integer, Array[Scenario], Environment, Hash[Scenario, String], World, IO) -> Integer
      def play_as_worker(number, list, environment, roles, world, pipe)
        @worker = number
        @out = WorkerOut.new(pipe)
        @records = nil
        @process_fixtures = FixtureCache.new
        @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}), secrets: -> { secrets })
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
        #: (IO) -> void
        def initialize(pipe)
          @pipe = pipe
          @held = []
        end

        #: (?untyped) -> void
        def puts(text = "")
          text = text.to_s
          text.start_with?("scenario start  ") ? Marshal.dump([:line, text], @pipe) : @held << text
        end

        #: () -> Array[String]
        def take = @held.slice!(0..)
      end

      # A head control and a base cell stand where the behaviour is absent,
      # so a Then failing there the same way in each proof run is proof.
      #: (String, Array[Hash[Symbol, untyped]]) -> bool
      def proving?(role, runs)
        absent = @world == "base" || (@world == "head" && role == "control")
        absent && runs.size < Table.proof_runs && runs.all? { _1[:execution].first == :fail } && runs.map { _1[:execution] }.uniq.size == 1
      end

      # A cell is what one scenario's executions in one environment came to;
      # a cell whose first execution broke a claim names it and what it read.
      # Its conditions are the ones the row's tags name, as the environment
      # gives them.
      #: (Array[Hash[Symbol, untyped]], Environment, String, Scenario) -> Hash[Symbol, untyped]
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
      #: (Array[Hash[Symbol, untyped]], Hash[Scenario, Array[Hash[Symbol, untyped]]], ?Hash[Scenario, Array[Hash[Symbol, untyped]]]) -> Hash[Symbol, untyped]
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
        # Judgments sit beside the verdicts, read after the table is built
        # and never folded into a row's verdict. A file that cannot be read
        # is a failed finding of its own, and its rows read as judged by
        # nothing.
        problems = [] #: Array[Hash[Symbol, untyped]]
        entries = {} #: Hash[String, Array[Hash[Symbol, untyped]]]
        entries_of = lambda do |feature|
          entries[feature] ||= begin
            read = JudgmentFile.read(@project, feature)
            if read[:problem]
              problems << { severity: "failed", code: "judgments-unread", file: JudgmentFile.of(feature),
                            message: "the judgments of #{feature} were not read: #{read[:problem]}, so its criteria read as judged by nothing",
                            fix: "repair #{JudgmentFile.of(feature)} by hand, or remove it and judge the criteria again with nuka judge" }
            end
            read[:entries] || []
          end
        end
        rows = Judgments.with_judgments(rows, scenarios, entries_of)
        # Under --base a reviewer reads which judgments the change added or
        # replaced, as the summary lists the mapping files that changed.
        warnings = [] #: Array[Hash[Symbol, untyped]]
        changed = @base && JudgmentFile.changed(@project, @base.commit)
        if @base && changed.nil?
          warnings << { severity: "warning", code: "judgments-not-compared", message: "the judgment files were not compared with the base: git did not answer" }
        end
        judged += Judgments.findings(rows, @id) + problems
        { run_id: @id, run_dir: File.join(".nukadoko/runs", @id), started_at: @started_at, finished_at: now, commit: @commit,
          environments: @environments.map { environment_entry(_1) }, worlds: @world_entries, order: @order,
          counts: RunRecord.counts(scenarios.reject { _1[:world] }), scenarios: scenarios,
          table: { base: @base && { ref: @base.ref, commit: @base.commit }, mapping_changed: @base&.mapping&.dig(:changed),
                   mapping_changes: @base&.mapping_changes, **(changed ? { judgments_changed: changed } : {}),
                   worlds: worlds, rows: rows, left_out: @left_out, proof_runs: Table.proof_runs },
          failures: warnings + executions.filter_map { _1[:failure] } + judged + @incomplete,
          # A criterion whose Then asks for a judgment holds only once one
          # cites what it read: the judgment column has a gate of its own.
          passed: @incomplete.empty? && rows.none? { Summary::RED.include?(_1[:verdict]) } && !Judgments.open?(rows) && problems.empty?,
          **(@walk ? { walk: @walk.record } : {}) }
      end

      # What `--base` knows of one row: its change, whether it carries
      # @held, whether the mapping changed, whether its tags or its name or
      # file changed, and whether its passing executions judged no claim in
      # Then position.
      #: (Scenario, Hash[Symbol, untyped]?, Array[Hash[Symbol, untyped]]) -> Hash[Symbol, untyped]?
      def context_of(scenario, change, executions)
        return nil unless change

        no_claim = Run.then_judged_by(scenario, executions)
        { change: change[:change], held: scenario.tags.include?(Criteria::HELD), mapping_changed: @base.mapping[:changed],
          retagged: change[:retagged] == true, renamed: !change[:renamed_from].nil?, then_judges_no_claim: no_claim }
      end

      # sources.json: the feature text this run parsed its scenarios from,
      # so `nuka report` renders the scenarios as they ran, long after the
      # files moved on. The project name rides along: it is part of an
      # Allure result's full name, and a copied run directory has no
      # package.json beside it.
      #: () -> void
      def write_sources
        package = File.join(@project, "package.json")
        name = begin
          (JSON.parse(File.read(package))["name"] if File.file?(package))
        rescue JSON::ParserError
          nil
        end
        features = @scenarios.map(&:uri).uniq.filter_map do |uri|
          file = File.join(@project, uri)
          { path: uri, source: File.read(file, encoding: "UTF-8") } if File.file?(file)
        end
        document = { schema_version: 1, project: name.is_a?(String) ? name : nil, features: features }
        File.write(File.join(@dir, "sources.json"), "#{JSON.pretty_generate(document)}\n")
      end

      # Why head's passing required executions of a row judged no claim in
      # Then position, from the first that says: `nothing`, or `judgment`
      # when its only claims there are judged-as claims.
      #: (Scenario, Array[Hash[Symbol, untyped]]) -> untyped
      def self.then_judged_by(scenario, executions)
        executions.lazy.map { _1[:json] }.filter_map do |json|
          json[:judged_by] if json[:feature] == scenario.uri && json[:line] == scenario.line && !json[:world] && json[:role] == "required" && json[:status] == "passed"
        end.first
      end

      #: () -> Array[Hash[Symbol, untyped]]
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
      #: (Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def judged_findings(rows)
        rows.filter_map do |row|
          next unless %w[unproven moved].include?(row[:verdict])

          command = ["nuka", "run", "#{row[:feature]}:#{row[:line]}", "--base", @base.commit, *@env_flags].map { Selection.shell_word(_1) }.join(" ")
          { severity: "failed", code: row[:verdict] == "unproven" ? "criterion-unproven" : "criterion-moved", file: row[:feature], line: row[:line],
            message: %(Scenario "#{row[:name]}" is #{row[:verdict]}: it #{row[:reason]}), do: command }
        end
      end

      #: (Environment) -> Hash[Symbol, untyped]
      def environment_entry(environment)
        { name: environment.name, conditions: environment.conditions.empty? ? nil : environment.conditions,
          target_version: nil, base_url: @base_urls[environment.name] }.compact.merge(target_version: nil, base_url: @base_urls[environment.name])
      end

      # The line before a scenario's execution, numbered across the run, in
      # the TypeScript engine's words so a log reads the same from either.
      #: (String, Integer, String, String) -> String
      def boundary(uri, line, name, role)
        @played += 1
        "scenario #{@played}/#{@to_play}  #{uri}:#{line}  #{name}#{role == "control" ? "  (control)" : ""}"
      end

      # The line before a control runs again for proof: which run of its cell
      # this is, of how many --proof-runs asks.
      #: (String, Integer, String, String, Integer) -> String
      def proof_boundary(uri, line, name, environment, run)
        "proof run #{run}/#{Table.proof_runs}  #{uri}:#{line}  #{name}  (control in #{environment})"
      end

      # Why a step failed, one line each: its error's first line, each step
      # it read from whose program exited nonzero, and where its record is.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def step_failure(record)
        lines = [Summary.first_error_line(record[:error].to_s)]
        Summary.exited_producers(record[:used]).each { |step, code, output| lines << "used    #{step}  exit #{code}  #{output}" }
        lines << "record  #{File.join(".nukadoko", "runs", @id, "steps", record[:step_record_id])}" if record[:step_record_id]
        lines
      end

      # Where a scenario's run starts again: its line, and its environment
      # unless that is the only one a run without --env would start.
      # In a shuffled order what ran before a scenario is part of what it
      # met, so the line names those scenarios, then it, with the order and
      # the run's --env flags. Under --repeat no one part of the order ran
      # before it, so the line is the run's own targets and flags.
      #: (Scenario, Environment) -> String
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

      #: (Scenario, Environment, String, World) -> Hash[Symbol, untyped]
      def play(scenario, environment, role, world)
        # The numbered line is the caller's: a worker's goes out with its
        # execution, numbered by the parent.
        @out.puts "scenario start  worker #{@worker}  #{scenario.uri}:#{scenario.line}  #{scenario.name}" if @worker
        started_at = now
        results = []
        stopped = nil #: Array[untyped]?
        @scratch = Scratch.new(@project)
        @scenario_fixtures = FixtureCache.new
        scenario_record_id = new_id("scn")
        @step_file = lambda do |record|
          RunRecord.step_file(record, environment: environment.name, world_name: @program.file? ? environment.name : nil, run_id: @id,
                                      scenario_record_id: scenario_record_id, evidence_dir: File.join(".nukadoko", "runs", @id, "steps", record[:step_record_id]))
        end
        # Where a person stopped the walk, as run.json's `stopped` says it.
        walk_stopped = nil #: Hash[Symbol, untyped]?
        @walk&.begin({ run_id: @id, run_dir: File.join(".nukadoko", "runs", @id),
                       scenario: { feature: scenario.uri, line: scenario.line, name: scenario.name, environment: environment.name },
                       world: world.base_url ? { url: world.base_url } : nil })
        records = scenario.steps.each_with_index.map do |line, index|
          began = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          record = stopped || walk_stopped ? skipped(line) : play_step(line, results, world)
          stopped ||= [record[:outcome], line.line, record[:claim], record[:broken_actual]] if record[:status] == "failed"
          seconds = format("%.1f", Process.clock_gettime(Process::CLOCK_MONOTONIC) - began)
          @out.puts "  step #{index + 1}/#{scenario.steps.size}  #{record[:status]}  #{seconds}s  #{line.text}"
          step_failure(record).each { @out.puts "      #{_1}" } if record[:status] == "failed"
          # A step with a written record ran, so a walk pauses after it.
          if @walk && record[:step_record_id] && record[:status] != "skipped"
            remaining = stopped ? 0 : scenario.steps.size - index - 1
            answer = pause(record, line, index + 1, scenario.steps.size, remaining)
            walk_stopped = { after_step: index + 1, line: line.line } if answer == "stop" && remaining.positive?
          end
          record
        end
        browser = @browser.scenario_browser
        final = @browser.end_scenario(File.join(@dir, "scenarios", scenario_record_id))
        @scenario_fixtures.teardown
        @scratch.remove_all
        execution = if stopped then stopped[0, 3].to_a.compact
                    elsif walk_stopped then [:stopped, walk_stopped[:line]]
                    else [:pass]
                    end
        failed = records.find { _1[:status] == "failed" }
        status = if stopped then "failed"
                 elsif walk_stopped then "stopped"
                 else "passed"
                 end
        json = { scenario_record_id: scenario_record_id, feature: scenario.uri, line: scenario.line, scenario: scenario.name,
                 status: status, **(walk_stopped && !stopped ? { stopped: walk_stopped } : {}),
                 environment: environment.name, started_at: started_at, finished_at: now, **(browser ? { browser: browser } : {}),
                 steps: scenario.steps.zip(records).map { |line, record| step_entry(line, record) }, hooks: [] } #: Hash[Symbol, untyped]
        json[:evidence] = { dir: File.join("scenarios", scenario_record_id), screenshots: final } if final.any?
        json[:do] = again(scenario, environment) if (failed || status == "stopped") && role != "control"
        json[:claims] = RunRecord.claim_counts(records)
        # A scenario in which no claim on a Then line was judged says so,
        # since a pass there shows only that nothing raised. A Then whose
        # only claims a reader judges compared nothing: its judgment is
        # what decides it.
        then_claims = scenario.steps.zip(records).select { |line, _| line_kind(line) == :then }.flat_map { _2[:claim_records] || [] }
        unless then_claims.any? { !%w[unobserved for-judgment].include?(_1[:outcome]) }
          json[:judged_by] = then_claims.any? { _1[:outcome] == "for-judgment" } ? "judgment" : "nothing"
        end
        json[:role] = role
        failure = if failed && role != "control"
                    { severity: "failed", code: "scenario-failed", file: scenario.uri, line: scenario.line,
                      message: "#{scenario.name}: #{failed[:error]}", do: json[:do] }
                  elsif (where = walk_stopped) && status == "stopped" && role != "control"
                    at = where[:line] ? " (line #{where[:line]})" : ""
                    { severity: "failed", code: "walk-stopped", file: scenario.uri, line: scenario.line,
                      message: "#{scenario.name}: the walk was stopped after step #{where[:after_step]}#{at} with nuka step stop, so the steps after it did not run",
                      do: json[:do] }
                  end
        { execution: execution, actual: stopped && stopped[3], json: json, failure: failure }
      end

      # The pause after the step that ran `number`th, under --step. Before
      # the walk waits, the open page's traffic moves to the pause's own
      # directory: a page that polls while the person reads is not the
      # step's work, and the step's record is already written. After a
      # failure nothing runs on `next` either, so nothing remains and a
      # `stop` there stops nothing.
      #: (Hash[Symbol, untyped], PickleStep, Integer, Integer, Integer) -> String?
      def pause(record, line, number, of, remaining)
        facts = { step: number, of: of, line: line.line, text: line.text, step_name: record[:step], status: record[:status] == "passed" ? "passed" : "failed",
                  step_record_id: record[:step_record_id], record: "steps/#{record[:step_record_id]}",
                  **(record[:error] ? { failure: { by: "step", message: record[:error] } } : {}), remaining: remaining }
        @walk.pause_after(facts) { |dir, recorded_as| @browser.hold(dir, recorded_as) }
      ensure
        @browser&.release
      end

      # One step as run.json's scenarios[].steps[] holds it.
      #: (PickleStep, Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def step_entry(line, record)
        # A line no step matches is `undefined`, and one more than one step
        # matches is `ambiguous`, as cucumber names them, so a messages
        # stream says the same of it as the TypeScript engine's.
        entry = { line: line.line, text: line.text, step: record[:step], status: record[:never_began] || record[:status],
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
          # A judgment cites a judged-as value by the digest of the whole value.
          entry[:claims] = record[:claim_records].map do |claim|
            claim[:outcome] == "for-judgment" && claim.key?(:actual) && !claim[:each] ? { **claim, value_digest: Judgments.value_digest(claim[:actual]) } : claim
          end
          entry[:observation] = record[:observation] || "observed"
          entry.merge!(RunRecord.poll_fields(record).except(:readings), **RunRecord.page_fields(record, File.join("steps", record[:step_record_id].to_s)))
        end
        entry
      end

      #: (PickleStep) -> Hash[Symbol, untyped]
      def skipped(line)
        { step: Engine.matches(@steps, line.text).first&.first&.step_name, status: "skipped", step_record_id: nil }
      end

      #: (PickleStep, Array[untyped], World) -> Hash[Symbol, untyped]
      def play_step(line, results, world)
        matched = Engine.matches(@steps, line.text)
        step, captures = matched.first
        unless step
          return { status: "failed", outcome: :broke, step_record_id: nil, error_kind: "step_error", error: %(No step definition matches "#{line.text}"), never_began: "undefined" }
        end
        # Under --no-check nothing refused the line before it ran, and
        # running the first match would pass a line the author meant for
        # another step.
        names = matched.map { _1.first.step_name }.uniq.sort
        if names.size > 1
          return { status: "failed", outcome: :broke, step_record_id: nil, error_kind: "step_error",
                   error: %("#{line.text}" matches more than one step: #{names.join(", ")}), never_began: "ambiguous" }
        end

        id = new_id("step")
        dir = File.join(@dir, "steps", id)
        record = { step_record_id: id, step: step.step_name, text: line.text, started_at: Time.now.utc.iso8601(3) }
        origins = {}
        execute(step, record, dir, world, then_line: line_kind(line) == :then, at_line: line.line, results: results, origins: origins) do
          args = bind_args(step, captures, line, results, origins, record)
          [args, (Pattern.new(step.pattern.to_s).texts(line.text) || {}).merge(attachment_texts(step, captures, line))]
        end
      end

      public

      # One step alone, as `nuka do` runs it: its args given on the command
      # line or by earlier records (`origins` says which), in a world
      # started for this one execution, its evidence in this run's
      # directory, which is the record's own.
      #: (singleton(Step), Hash[String, untyped], Hash[String, String], Hash[String, String], Environment) -> Hash[Symbol, untyped]
      def do_step(step, args, origins, texts, environment)
        FileUtils.mkdir_p(@dir)
        read_env(environment)
        world = @program.start(environment, @dir, @project)
        @program_log = world.log_path && Trace::Log.new(world.log_path, world.trace_prefix)
        @scratch = Scratch.new(@project)
        @scenario_fixtures = FixtureCache.new
        @process_fixtures = FixtureCache.new
        @browser = Browser.new(world.base_url, Nukadoko.config_options.fetch(:browser, {}), secrets: -> { secrets })
        record = { step_record_id: @id, step: step.step_name, started_at: now }
        execute(step, record, @dir, world, then_line: true, at_line: nil, results: [], origins: origins) { [args, texts] }
      ensure
        @browser&.close
        @scenario_fixtures&.teardown
        @process_fixtures&.teardown
        @scratch&.remove_all
        world&.stop
      end

      # What `nuka do` writes its stdout and its record through.
      #: (untyped) -> untyped
      def redact(value) = secrets.redact(value)

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
              Processes.collect(processes) { RedactedOutput.around(secrets) { body(step, fixtures, args, [then_line, at_line], record, results, origins, texts) } }
            end
          end
          record[:page_view] = @browser.judged(dir, record[:step_record_id], aria_in_claims: step.claims.to_a.any? { !_1[:each] && _1[:compare] == "fits-aria-snapshot" }) if step.claims && fixtures[:page] && record[:observation] != "unobserved"
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

              File.write(File.join(dir, "process-#{n}.#{stream}.txt"), secrets.redact(output[stream]))
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
          File.write(File.join(dir, "http.jsonl"), "#{log.map { JSON.generate(secrets.redact(_1)) }.join("\n")}\n") if log.any?
          record[:http_file] = log.any?
          if (traced = TraceActions.read(File.join(dir, "trace.zip")))
            record[:trace] = "trace.zip"
            record[:actions] = traced[:actions] if traced[:actions].any?
            record[:actions_truncated] = traced[:truncated] if traced[:truncated]
          end
          measure(step, record, dir) if record[:claim_records]
          File.write(File.join(dir, "record.json"), JSON.pretty_generate(secrets.redact(@step_file ? @step_file.(record) : record)))
        end
        record
      end

      # A Then step's claims are judged on what it observed, or on its args
      # when it reads nothing itself; any other step runs and returns.
      # `step` is a step class whose observe or run its own file defines.
      #: (untyped, Hash[Symbol, untyped], untyped, [bool, Integer?], Hash[Symbol, untyped], Array[untyped], Hash[String, String], Hash[String, String?]) -> void
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

            observed = step.new.observe(**step.keywords(own, step.inputs.load(args)))
            observed = observed.is_a?(Hash) ? observed.transform_keys(&:to_s).merge(from_values) : observed
            Claims.take_aria_snapshots(step.claims, observed)
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
            next nil if declared[:compare] == "fits-aria-snapshot"

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
          broken = record[:claim_records].index { !%w[held for-judgment].include?(_1[:outcome]) }
          return unless broken

          message = RunRecord.broken_message(record[:claim_records])
          first, *rest = message.split("\n", -1)
          message = ["#{first}#{RunRecord.poll_end(step, record)}", *rest].join("\n")
          record.merge!(status: "failed", outcome: then_line ? :fail : :broke, claim: broken,
                        broken_actual: judged[broken][:actual], error_kind: "claim_broken", error: message)
        else
          value, problems = step.returned(step.new.run(**step.keywords(fixtures.slice(*step.fixtures), step.inputs.load(args))))
          if problems.any?
            record[:error_kind] = "result_invalid"
            raise TypeError, "returns validation failed: #{problems.join("; ")}"
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
      #: (singleton(Step), Hash[Symbol, untyped], String) -> void
      def measure(step, record, dir)
        own = record[:step_record_id]
        own_channels = Measured.channels(dir, { processes: record[:processes], files: record[:files] }, record[:http_count].to_i.positive? ? "http.jsonl" : nil)
        cache = {}
        channels_of = lambda do |id|
          next own_channels if id == own

          cache[id] ||= begin
            found = [File.join(@dir, "steps", id), File.join(@project, ".nukadoko", "do", id)].find { File.exist?(File.join(_1, "record.json")) }
            other = found && JSON.parse(File.read(File.join(found, "record.json")), symbolize_names: true)
            other && found ? Measured.channels(found, other[:observed] || {}, other.dig(:evidence, :http)) : [{ channel: "record", unknown: true }]
          end
        end
        from_of = ->(key) { (origin = (record[:args_origin] || {})[key.to_s.split(".").first]).is_a?(Hash) ? origin.dig(:from, :step_record_id) : nil }
        (step.claims || []).zip(record[:claim_records], record[:raw_actuals] || []).each do |declared, claim, raw|
          next if claim.nil? || claim[:outcome] == "unobserved" || declared[:each]
          # A tree nukadoko took is a measurement of the page, not a value a channel carried.
          next claim[:measured] = nil if declared[:compare] == "fits-aria-snapshot" || claim[:actual_from].to_s.start_with?(Judgments::ARIA_LABEL)

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

      #: (singleton(Step), Hash[String, untyped], PickleStep, Array[untyped], Hash[String, String], Hash[Symbol, untyped]) -> Hash[String, untyped]
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
      #: (singleton(Step), Hash[String, untyped], PickleStep) -> Hash[String, String]
      def attachment_texts(step, captures, line)
        open = step.args.fields.map { _1.name.to_s } - captures.keys - step.from.keys
        return {} if open.empty?
        return { open.first => line.doc_string } if line.doc_string
        return { open.first => line.table.map { |row| "| #{row.join(" | ")} |" }.join("\n") } if line.table

        {}
      end

      #: (PickleStep) -> Symbol
      def line_kind(line) = line.kind == "Outcome" ? :then : :other

      # A project fixture is built the first time a step of its scope names
      # it, directly or through another fixture, and kept until the scope ends.
      #: (Symbol, World, Array[Symbol]) -> untyped
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
      #: (Symbol, Symbol, Integer?, String?) -> void
      def note_fixture(name, scope, setup_ms, at)
        return if @fixture_usage.nil? || @fixture_usage.any? { _1[:name] == name.to_s }

        @fixture_usage << { name: name.to_s, scope: scope.to_s, reused: setup_ms.nil?, setup_ms: setup_ms, at: at }.compact
      end

      # The secrets of the environment running now, which every record
      # surface is written through.
      #: () -> Secrets
      def secrets = @secrets || Secrets.new

      # What the env fixture holds: the env files, then the world's own env.
      #: (World) -> Hash[String, String]
      def step_env(world) = (@env_vars || {}).merge(world.env)

      # Reads an environment's env files into the env fixture and the secret
      # set, from the same read, so the two agree on what was loaded.
      #: (Environment) -> void
      def read_env(environment)
        EnvCheck.validate!
        config = Nukadoko.config_options.fetch(:secrets, {}) #: Hash[Symbol, untyped]
        # A tree's checkout holds no env file git ignores, and head's are
        # the ones the person keeps.
        root = @head ? @head[:root].to_s : @project
        @env_vars = EnvFile.load(root, environment.env_files)
        @secrets = Secrets.of(root, environment.env_files, public_keys: (config[:public] || []).map(&:to_s), redact_keys: (config[:redact] || []).map(&:to_s))
        head = @head
        return unless head

        @secrets = @secrets.with(Secrets.of(root, head[:env_files], public_keys: head[:public], redact_keys: head[:redact]))
      rescue EnvFile::Unreadable => e
        raise Refusal.new("env-file-unreadable", e.message)
      end

      #: (singleton(Step), String, Array[Hash[Symbol, untyped]], World, Hash[Symbol, untyped]) -> [Hash[Symbol, untyped], (^() -> void)?]
      def build_fixtures(step, dir, log, world, record)
        finish = nil
        @fixture_usage = []
        fixtures = (step.bag - [:call]).to_h do |name|
          case name
          when :request then [name, Request.new(world.base_url)]
          when :baseURL then [name, world.base_url]
          when :env then [name, step_env(world)]
          when :requireEnv then [name, ->(key) { step_env(world).fetch(key.to_s) { raise %(requireEnv("#{key}"): the world's env has no #{key}) } }]
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

      #: (String) -> String
      def new_id(kind) = "#{kind}-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"

      #: () -> String
      def now = Time.now.utc.iso8601(3)
    end
  end
end
