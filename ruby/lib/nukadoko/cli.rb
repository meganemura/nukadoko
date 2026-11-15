# frozen_string_literal: true
# rbs_inline: enabled

# The `nuka` command. With --json it prints one envelope in the shape the
# TypeScript engine prints, so an agent reads both engines the same way.
module Nukadoko
  class CLI
    FLAGS = %w[--json --no-check --dry-run --then --replace --allure --records --meets --misses --step].freeze
    REPEATED = %w[--tag --env --use].freeze
    VALUED = %w[--format --out --base --repeat --concurrency --order --proof-runs --args --pattern --description --feature --command --request --from --cwd --body --argv
                --run --by --because --walk --timeout].freeze

    #: (Array[String], ?project: String, ?out: IO) -> void
    def initialize(argv, project: Dir.pwd, out: $stdout)
      @command, *rest = argv
      @words = rest.dup
      @options = Hash.new { |h, k| h[k] = [] }
      @rest = []
      @unknown = []
      parse(rest)
      @json = @options.key?("--json")
      @no_check = @options.key?("--no-check")
      @project = File.expand_path(project)
      @out = out
    end

    #: () -> Integer
    def call
      return refuse(Engine::Refusal.new("invalid-arguments", "Unknown argument: #{@unknown.first}")) if @unknown.any?
      return verdict if @command == "verdict"
      return Judge.new(@project, @rest, @options, json: @json, out: @out).call if @command == "judge"
      return report if @command == "report"
      return clean if @command == "clean"
      return Walked.new(@project, @rest, @options, json: @json, out: @out).call if @command == "step"
      return skill if @command == "skill"
      return init if @command == "init"

      %w[nukadoko.config.rb nukadoko.program.rb].each do |name|
        file = File.join(@project, name)
        load file if File.exist?(file)
      end
      steps = Nukadoko.load_steps(File.join(@project, "features", "steps"))
      problems = []
      scenarios = Dir.chdir(@project) { Engine.load_features("features", problems: problems) }
      declared = (Nukadoko.program_options[:environments] || {}).values.flat_map { (_1[:conditions] || {}).keys.map(&:to_s) }
      # condition-unmet is judged for the selection a run without --env
      # starts; a selection --env names is a choice of where to run.
      selected = (Engine::Program.new(Nukadoko.program_options).environments if Array(@options["--env"]).empty?) rescue nil
      check = Engine::Check.new(steps, scenarios, features: Dir.exist?(File.join(@project, "features")), full: @command == "check",
                                conditions: declared, environments: selected, problems: problems)
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
      when "run" then @options.key?("--step") ? walk(steps) : run(steps)
      when "do" then run_one(check)
      when "scaffold" then scaffold(steps, scenarios)
      when "__tree" then tree(steps)
      else
        warn "usage: nuka check|run|verdict|steps|describe <step>|sig [--json] [--no-check]"
        2
      end
    end

    private

    # `--name value` and `--name=value` for the repeated options, bare
    # flags, and every other word a target. An unknown `--name` is kept to
    # refuse, so a typo never reads as a target or is silently ignored.
    #: (Array[String]) -> void
    def parse(words)
      until words.empty?
        word = words.shift
        name, value = word.split("=", 2)
        name = name.to_s
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

    # `nuka run --step`: a run of one scenario that pauses after each step
    # until `nuka step` answers. The walk is recorded before anything else,
    # so every way the run stops reaches a `nuka step` waiting for it: a
    # refusal or nothing selected ends it as not run, with what the run
    # printed; a signal, which is what ends a pause nobody answers, as
    # interrupted; an exception as an error.
    #: (Array[singleton(Step)]) -> Integer
    def walk(steps)
      targets = @rest.empty? ? ["features"] : @rest
      @walk_target = [*targets, *@options["--env"].flat_map { ["--env", _1] }].map { Engine::Selection.shell_word(_1) }.join(" ")
      opened = Engine::WalkFiles.open(@project, @walk_target, announce: @json ? nil : ->(text) { $stderr.write(text) })
      if opened.is_a?(Hash)
        return refuse(Engine::Refusal.new("walk-in-progress", opened[:message], run: "nuka step wait"))
      end

      @walk = opened
      previous = { "INT" => 130, "TERM" => 143 }.to_h do |name, code|
        [name, Signal.trap(name) do
          opened.end({ how: "interrupted", exit_code: code, signal: "SIG#{name}" })
          exit(code)
        end]
      end
      code = run(steps)
      opened.end({ how: "not-run", exit_code: code, findings: @stopped_with || [] })
      code
    rescue StandardError => e
      opened.end({ how: "error", exit_code: 1, findings: [{ severity: "error", code: "unexpected-error", message: e.message }] }) if opened.is_a?(Engine::WalkFiles::Handle)
      raise
    ensure
      previous&.each { |name, handler| Signal.trap(name, handler || "DEFAULT") }
    end

    # Why a walk cannot walk this run, raised as step-needs-one-scenario: a
    # walk is one execution of one scenario, in one environment, where its
    # conditions hold, since a control would run again for its proof.
    #: (Array[Engine::Scenario], Array[Engine::Environment]) -> void
    def one_execution(kept, environments)
      first = kept.first
      at = Engine::Selection.shell_word("#{first.uri}:#{first.line}")
      envs = @options["--env"].flat_map { ["--env", Engine::Selection.shell_word(_1)] }
      reason, again = if kept.size > 1
                        ["the targets select #{kept.size} scenarios", Engine::Walk.restart_command([at, *envs].join(" "))]
                      elsif environments.size > 1
                        ["it runs in #{environments.size} environments (#{environments.map(&:name).join(", ")})",
                         Engine::Walk.restart_command([at, "--env", Engine::Selection.shell_word(environments.first.name)].join(" "))]
                      elsif Engine::Table.role(Engine::Table.condition_tags(first.tags), environments.first.conditions) == "control"
                        ["the scenario's conditions do not hold in #{environments.first.name}, so it would run as a control"]
                      end
      return unless reason

      raise Engine::Refusal.new("step-needs-one-scenario", "nuka run --step walks one execution of one scenario, and #{reason}", run: again)
    end

    # A run checks the scenarios it selected, then runs them in each world
    # it selected; a target or a world it cannot reach is refused first.
    #: (Array[singleton(Step)]) -> Integer
    def run(steps)
      repeat = count_flag("--repeat")
      concurrency = count_flag("--concurrency")
      Engine::Table.proof_runs = count_flag("--proof-runs")
      order = Engine::Order.read(@options["--order"].last)
      unless order
        raise Engine::Refusal.new("invalid-value", "--order must be file, shuffled, or shuffled:<seed> with a whole number from 0 to #{Engine::Order::MAX_SEED} (got #{JSON.generate(@options["--order"].last)}).")
      end

      # Progress is stderr's, so stdout holds only what was asked for: the
      # records under --records, the envelope under --json. Under --json
      # nothing else is written, and a warning is a finding in the envelope.
      records = @options.key?("--records") ? @out : nil
      progress = @json ? File.open(File::NULL, "w") : $stderr
      ref = @options["--base"].last
      if @walk && (repeat > 1 || ref)
        why = repeat > 1 ? "--repeat #{repeat} runs it #{repeat} times" : "--base runs it in more than one world"
        raise Engine::Refusal.new("step-needs-one-scenario", "nuka run --step walks one execution of one scenario, and #{why}",
                                  run: Engine::Walk.restart_command(@walk_target))
      end
      commit = ref && Engine::Base.resolve(@project, ref)
      selection = Engine::Selection.new(@project, @rest, @options["--tag"])
      program = Engine::Program.new(Nukadoko.program_options)
      environments = program.environments(@options["--env"])
      # A scenario whose conditions hold in no environment of the run is
      # left out, and counted, since no cell of it could show it holds.
      kept, left_out = selection.scenarios.partition { meets?(_1, environments) }
      kept = Engine::Order.arrange(kept, order)
      # Without --env, a scenario no environment meets is a check error,
      # condition-unmet; a selection --env names leaves it out instead.
      default = @options["--env"].empty?
      declared = program.declared.values.flat_map { (_1[:conditions] || {}).keys.map(&:to_s) }
      check = Engine::Check.new(steps, default ? selection.scenarios : kept, conditions: declared,
                                environments: (environments if default), problems: selection.problems)
      # Only the check's errors hold a run back, so only they are reported.
      findings = @no_check ? [] : check.findings.map { relative(_1).to_h }.select { _1[:severity] == "error" }
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
      one_execution(kept, environments) if @walk && kept.any?

      dir = File.join(@project, ".nukadoko", "runs", "run-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}")
      base = if commit
               targets = @rest.empty? ? nil : @rest.map { _1.sub(/:\d+\z/, "") }
               Engine::Base.new(project: @project, ref: ref, commit: commit, run_dir: dir, selected: kept.map { Engine::Criteria.key(_1.uri, _1.line) },
                                targets: targets, envs: @options["--env"], head_program: Nukadoko.program_options)
             end
      # Workers are handed whole feature files, so one file has nothing to
      # spread across them.
      if concurrency > 1 && kept.map(&:uri).uniq.size <= 1
        progress.puts "--concurrency has nothing to distribute: this run selects one feature file."
        concurrency = 1
      end
      result = Engine::Run.new(@project, check.usable, kept, Nukadoko.program_options,
                               environments: environments, left_out: left_out.size, out: progress,
                               dir: dir, base: base, env_flags: @options["--env"].flat_map { ["--env", _1] },
                               repeat: repeat, concurrency: concurrency, order: order, records: records, walk: @walk,
                               rerun: { targets: @rest, tags: @options["--tag"].flat_map { ["--tag", _1] }, whole_files: selection.whole_files }).call
      passed = result.delete(:passed)
      findings += result.delete(:failures)
      started = result.slice(:run_id, :run_dir, :started_at, :finished_at, :commit, :environments, :worlds)
      rest = result.except(*started.keys)
      envelope = { **head("run", passed ? "passed" : "failed", findings, check: @no_check ? "skipped" : "ran"),
                   **started, selection: selection.selection, tag_selection: selection.tag_selection, **rest } #: Hash[Symbol, untyped]
      envelope.delete(:tag_selection) unless envelope[:tag_selection]
      # The limits restate the fields above, so they are read from them,
      # and a run with none has no field.
      limits = Engine::Summary.limits(JSON.parse(JSON.generate(envelope), symbolize_names: true))
      envelope[:limits] = limits if limits.any?
      File.write(File.join(@project, result[:run_dir], "run.json"), "#{JSON.pretty_generate(envelope)}\n")
      # The summary is rendered from run.json as written, so it can say
      # nothing the record does not.
      written = JSON.parse(JSON.generate(envelope), symbolize_names: true)
      File.write(File.join(@project, result[:run_dir], "summary.md"), Engine::Summary.render(written))
      # After run.json, so a `nuka step` that reads the walk as ended finds
      # the run's record there.
      scenarios = envelope[:scenarios] #: Array[Hash[Symbol, untyped]]
      stopped = scenarios.find { _1[:stopped] }&.dig(:stopped)
      @walk&.end({ how: "finished", exit_code: passed ? 0 : 1, findings: findings, **(stopped ? { stopped: stopped } : {}) })
      unless @json
        written = Dir.children(File.join(@project, result[:run_dir], "steps")).size
        steps_dir = "#{File.join(result[:run_dir], "steps")}/"
        progress.puts "steps     #{steps_dir.ljust([30, steps_dir.size + 2].max)}#{written}" if envelope[:counts][:scenarios].positive?
        progress.puts "summary   #{File.join(result[:run_dir], "summary.md")}"
        progress.puts "run       #{File.join(result[:run_dir], "run.json")}"
        run_end(envelope, progress)
      end
      emit(envelope, findings, "run", io: progress)
      if limits.any? && !@json
        progress.puts "limits: #{limits.group_by { _1[:kind] }.map { |kind, group| "#{group.size} #{kind}" }.join(", ")} (run.json limits)"
      end
      repeat_tallies(scenarios, progress) if repeat > 1 && !@json
      passed ? 0 : 1
    rescue Engine::Refusal => e
      refuse(e)
    end

    # `--repeat`, `--concurrency`, and `--proof-runs` take a whole number of 1 or more.
    #: (String) -> Integer
    def count_flag(name)
      value = @options[name].last
      return 1 if value.nil? && name != "--proof-runs"
      return Engine::Table::PROOF_RUNS if value.nil?

      number = Integer(value, 10, exception: false)
      return number if number && number >= 1

      raise Engine::Refusal.new("invalid-value", "#{name} must be a whole number of 1 or more (got #{value}).")
    end

    # One pass of a `--base` tree, in the tree's own directory: the plan
    # names the world, the environment, and the rows at their place in this
    # tree, and the result goes to the file it names.
    #: (Array[singleton(Step)]) -> Integer
    def tree(steps)
      plan = JSON.parse(File.read(@rest.first), symbolize_names: true)
      found = Dir.chdir(@project) { Engine.load_features(plan[:targets].map { _1[:feature] }.uniq) }
      scenarios = plan[:targets].filter_map { |target| found.find { _1.uri == target[:feature] && _1.line == target[:line] } }
      result = begin
        environment = Engine::Program.new(Nukadoko.program_options).environments([plan[:environment]]).first
        usable = Engine::Check.new(steps, scenarios).usable
        run = Engine::Run.new(@project, usable, scenarios, Nukadoko.program_options, environments: [environment],
                              world: plan[:world], dir: plan[:dir], out: @out)
        { results: run.tree_pass, worlds: run.world_entries }
      rescue Engine::Refusal => e
        { not_run: "the #{plan[:world]} tree's program file does not give this environment: #{e.message}" }
      end
      File.write(plan[:result], JSON.generate(result))
      0
    end

    # `nuka do <step>`: one step alone, its args from --args and from the
    # records --use names, in a world started for it. The step record goes
    # to stdout and to .nukadoko/do/<id>/record.json, where a later
    # `nuka do --use` reads it. A refusal goes to stderr, since stdout is
    # the record's.
    # Paths written go to stdout, notes and refusals to stderr.
    #: () -> Integer
    def init
      @out = $stderr
      return refuse(Engine::Refusal.new("invalid-arguments", "Unknown argument: json")) if @json
      return refuse(Engine::Refusal.new("invalid-arguments", "--allure is not in the Ruby engine yet")) if @options.key?("--allure")

      result = Engine::Init.new(@project, out: $stdout, err: $stderr).call
      result.is_a?(Engine::Refusal) ? refuse(result) : result
    end

    # Writes stubs; their paths go to stdout, and notes and refusals to stderr.
    #: (Array[singleton(Step)], Array[Engine::Scenario]) -> Integer
    def scaffold(steps, scenarios)
      @out = $stderr
      return refuse(Engine::Refusal.new("invalid-arguments", "Unknown argument: json")) if @json
      if @rest.empty? && !@options.key?("--feature")
        return refuse(Engine::Refusal.new("invalid-arguments", "Missing required argument: name (or --feature <path>)"))
      end

      scaffold = Engine::Scaffold.new(@project, @options, @rest, steps, scenarios)
      scaffold.argv_words = @words.map { Engine::Selection.shell_word(_1) }
      result = scaffold.call
      return refuse(result) if result.is_a?(Engine::Refusal)

      written, notes = result
      written.each { $stdout.puts _1 }
      notes.each { $stderr.puts _1 }
      0
    end

    #: (Engine::Check) -> Integer
    def run_one(check)
      @out = $stderr
      return refuse(Engine::Refusal.new("invalid-arguments", "Unknown argument: json")) if @json

      name = @rest.first
      step = check.usable.find { _1.step_name == name }
      return refuse(Engine::Refusal.new("unknown-step", "Unknown step: #{name}", fix: "Name a step that nuka steps lists.", run: "nuka steps")) unless step

      describe = "nuka describe #{name}"
      args_fix = "Pass --args as a JSON object with the keys that nuka describe <step> lists."
      given = {}
      if (text = @options["--args"].last)
        begin
          given = JSON.parse(text)
        rescue JSON::ParserError => e
          return refuse(Engine::Refusal.new("step-args-invalid", "Invalid JSON for --args: #{e.message.lines.first.strip}", fix: args_fix, run: describe))
        end
        return refuse(Engine::Refusal.new("step-args-invalid", "--args must be a JSON object", fix: args_fix, run: describe)) unless given.is_a?(Hash)
      end
      args, origins, used = used_args(step, @options["--use"])
      if @options["--args"].empty? && (step.args.fields.map { _1.name.to_s } - args.keys).any?
        return refuse(Engine::Refusal.new("step-args-invalid", "--args is required unless --use supplies this step's arguments", fix: args_fix, run: describe))
      end

      args = given.merge(args.reject { |key, _| given.key?(key) })
      given.each_key { origins[_1] = "command_line:#{_1}" }
      environment = Engine::Program.new(Nukadoko.program_options).environments(@options["--env"].last(1)).first
      id = "step-#{Time.now.utc.strftime("%Y%m%d-%H%M%S")}-#{SecureRandom.alphanumeric(4).downcase}"
      dir = File.join(@project, ".nukadoko", "do", id)
      run = Engine::Run.new(@project, check.usable, [], Nukadoko.program_options, environments: [environment], dir: dir, out: $stderr)
      texts = given.to_h { |key, value| [key, JSON.generate(value)] }
      record = run.do_step(step, args, origins, texts, environment)
      written = do_record(record, id, step, given, origins, used, environment)
      File.write(File.join(dir, "record.json"), JSON.pretty_generate(written))
      $stdout.puts JSON.pretty_generate(written)
      record[:status] == "passed" ? 0 : 1
    rescue Engine::Refusal => e
      refuse(e)
    end

    # Each from key of the step, from the newest record --use names whose
    # step gives it, and where it came from.
    #: (singleton(Step), Array[String]) -> [Hash[untyped, untyped], Hash[untyped, String], Array[Hash[Symbol, untyped]]]
    def used_args(step, ids)
      records = ids.map do |id|
        path = [File.join(@project, ".nukadoko", "do", id, "record.json"), *Dir.glob(File.join(@project, ".nukadoko", "runs", "*", "steps", id, "record.json"))].find { File.exist?(_1) }
        unless path
          raise Engine::Refusal.new("step-inputs-invalid", "--use #{id}: no such step record. A step record is removed with its run once the run is older than the newest 20 runs, " \
                                                           "and a nuka do record once it is older than 7 days (retention in nukadoko.config.rb)")
        end
        [id, JSON.parse(File.read(path))]
      end
      args = {}
      origins = {}
      used = []
      step.from.each do |key, sources|
        sources.each do |cls, source_key|
          id, found = records.reverse.find { |_, record| record["step"] == cls.step_name && record["result"].is_a?(Hash) && record["result"].key?(source_key.to_s) }
          next unless found

          args[key] = found["result"][source_key.to_s]
          origins[key] = "from:#{cls.step_name}@#{id}.#{source_key}"
          used << { step_record_id: id, step: cls.step_name, result: found["result"] } unless used.any? { _1[:step_record_id] == id }
          break
        end
      end
      [args, origins, used]
    end

    # The record `nuka do` prints, in the TypeScript engine's shape.
    #: (Hash[Symbol, untyped], String, singleton(Step), Hash[untyped, untyped], Hash[untyped, String], Array[Hash[Symbol, untyped]], Engine::Environment) -> Hash[Symbol, untyped]
    def do_record(record, id, step, given, origins, used, environment)
      args_origin = (record[:args] || {}).keys.to_h do |key|
        origin = origins[key]
        if origin&.start_with?("from:")
          step_name, rest = origin.delete_prefix("from:").split("@", 2)
          record_id, source_key = rest.to_s.split(".", 2)
          [key, { from: { step_record_id: record_id, step: step_name, key: source_key } }]
        else [key, "command_line"]
        end
      end
      passed = record[:status] == "passed"
      outcome = passed ? { result: record[:result] || {}, returns_dropped: record[:returns_dropped] || [] } : { error: { message: record[:error], kind: record[:error_kind] } }
      processes = record[:processes]
      { schema_version: Engine::RunRecord::SCHEMA_VERSION, nukadoko: VERSION, step_record_id: id, step: step.step_name, kind: "do",
        args: record[:args] || given, args_origin: args_origin, **outcome, status: record[:status], environment: environment.name,
        world_name: nil, scenario_record_id: nil, run_id: nil, started_at: record[:started_at], finished_at: record[:finished_at],
        evidence: { dir: File.join(".nukadoko", "do", id), screenshots: [] },
        observed: { processes: processes&.any? ? processes : nil,
                    http: record[:http_count]&.positive? ? record[:http_count] : nil, files: nil, unmeasured: [] },
        mutates: record[:mutates], **(used.any? ? { used: used } : {}),
        **(record[:claim_records] ? { claims: record[:claim_records], observation: record[:observation] || "observed", attempts: 1 } : {}) }
    end

    #: (Engine::Scenario, Array[Engine::Environment]) -> bool
    def meets?(scenario, environments)
      tags = Engine::Table.condition_tags(scenario.tags)
      environments.any? { Engine::Table.role(tags, _1.conditions) == "required" }
    end

    # The `nuka check` that reports the same errors: the files the targets
    # name, and each --env.
    #: () -> String
    def check_command
      files = @rest.map { _1.sub(/:\d+\z/, "") }.uniq
      ["nuka check", *files.map { Engine::Selection.shell_word(_1) }, *@options["--env"].flat_map { ["--env", Engine::Selection.shell_word(_1)] }].join(" ")
    end

    # Why --env left out every selected scenario, and the run that meets
    # them: the run without --env when it does, else the first environment
    # of the program file that meets each, or else one that meets some.
    #: (Array[Engine::Scenario], Engine::Program) -> Hash[Symbol, String]
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

      candidates = [*program.declared.keys, *(program.declared.key?("default") ? [] : ["default"])] - envs
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
    #: () -> Integer
    def clean
      state = File.join(@project, ".nukadoko")
      listed = ->(dir) { Dir.children(File.join(state, dir)).select { File.directory?(File.join(state, dir, _1)) }.sort.map { ".nukadoko/#{dir}/#{_1}" } rescue [] }
      results = File.join(state, "export", "allure-results")
      # The run of a live walk stays: it still writes there, and `nuka
      # step` answers through it. A walk still starting may have made its
      # directory without naming it yet, so every run with no run.json
      # stays while it starts.
      live = Engine::WalkFiles.live_run(@project)
      runs, kept = listed.("runs").partition do |dir|
        next true unless live

        live[:run_dir] == "starting" ? File.exist?(File.join(@project, dir, "run.json")) : dir != live[:run_dir]
      end
      plan = {
        records: runs + listed.("do"),
        export: File.directory?(results) && !Dir.empty?(results) ? [".nukadoko/export/allure-results"] : [],
        legacy: %w[cache records].select { File.directory?(File.join(state, _1)) }.map { ".nukadoko/#{_1}" },
        kept: kept
      }
      walk = live&.dig(:walk)
      notes = kept.map do |dir|
        { severity: "note", code: "walk-run-kept", message: "kept #{dir}: walk #{walk} is live and its run writes there", do: Engine::Walk.wait_command(walk.to_i) }
      end
      dry_run = @options.key?("--dry-run")
      gone = plan[:records] + plan[:export] + plan[:legacy]
      if @json
        emit({ **head("clean", "passed", notes), **plan, dry_run: dry_run }, notes, "clean")
      else
        gone.each { @out.puts _1 }
        @out.puts "ok: nothing to clean" if gone.empty?
        notes.each { $stderr.puts [_1[:severity], _1[:code], Engine::Summary.where_of(_1), _1[:message]].join("\t"), "  do: #{_1[:do]}" }
      end
      return 0 if dry_run

      gone.each { FileUtils.rm_rf(File.join(@project, _1)) }
      # An `allure watch` already pointed at the results directory keeps
      # finding it.
      FileUtils.mkdir_p(results) if plan[:export].any?
      0
    end

    # `nuka skill path`, the one verb, as the TypeScript engine has it.
    #: () -> Integer
    def skill
      verb = @rest.first
      return Skill.print_path(@out, $stderr) if verb == "path" && @rest.size == 1
      return refuse(Engine::Refusal.new("invalid-arguments", "Not enough non-option arguments: got 0, need at least 1")) if verb.nil?

      refuse(Engine::Refusal.new("invalid-arguments", "Unknown argument: #{(@rest - ["path"]).first || verb}"))
    end

    # Renders a finished run again from its run.json alone: the run a
    # directory names, or the newest one.
    #: () -> Integer
    def report
      format = @options["--format"].last
      out = @options["--out"].last
      raise Engine::Refusal.new("invalid-arguments", "Missing required argument: format") unless format
      unless %w[markdown allure messages].include?(format)
        raise Engine::Refusal.new("invalid-arguments", %(Invalid values:;   Argument: format, Given: #{JSON.generate(format)}, Choices: "markdown", "allure", "messages"))
      end
      if @json && !out && format != "allure"
        raise Engine::Refusal.new("invalid-arguments", "nuka report --json needs --out for --format #{format}, since the #{format} output itself would go to stdout",
                                  fix: "Add --out <path>.")
      end

      dir = report_dir
      kind = format == "allure" ? :dir : :file
      target = out ? File.expand_path(out, @project) : (File.join(@project, ".nukadoko", "export", "allure-results") if kind == :dir)
      label = out ? "--out #{out}" : "the default allure directory #{target && shown_path(target)}"
      if target && (problem = out_problem(target, kind, label))
        raise Engine::Refusal.new("report-out-invalid", problem)
      end

      problems = [] #: Array[String]
      if format == "markdown"
        doc = JSON.parse(File.read(File.join(dir, "run.json"), encoding: "UTF-8"), symbolize_names: true)
        text = Engine::Summary.render(doc)
      else
        run = Engine::ReportRun.new(dir, project_root: @project)
        doc = run.document
        text = Engine::ReportMessages.render(run) if format == "messages"
        problems = run.problems.dup
      end
      # A part of the run the render left out is a failed finding of its
      # own, and the rest is still written.
      findings = -> { problems.map { { severity: "failed", code: "report-incomplete", message: _1 } } }
      unless target
        emit({}, findings.(), "report", io: $stderr)
        @out.write(text)
        return problems.empty? ? 0 : 1
      end

      exports = own_exports(dir, doc[:run_id], problems)
      replace_own_exports(exports, target, kind)
      FileUtils.mkdir_p(kind == :dir ? target : File.dirname(target))
      if run && format == "allure"
        files = Engine::ReportAllure.write(run, target, ->(message) { problems << message })
      else
        File.write(target, text)
        files = [target]
      end
      note_own_exports(exports, files)
      written = Pathname.new(target).relative_path_from(Pathname.new(@project)).to_s
      return finish("report", problems.empty?, findings: findings.(), run_id: doc[:run_id], format: format, written: [written]) if @json

      emit({}, findings.(), "report", io: $stderr)
      if kind == :dir
        count = files.count { _1.end_with?("-result.json") }
        $stderr.puts "#{format.ljust(10)}#{"#{written}/".then { _1.ljust([30, _1.size + 2].max) }}#{count}"
      else
        $stderr.puts "#{format.ljust(10)}#{written}"
      end
      problems.empty? ? 0 : 1
    rescue Engine::Refusal => e
      refuse(e)
    end

    # Why a report cannot go to `target`, or nil when it can.
    #: (String, Symbol, String) -> String?
    def out_problem(target, kind, label)
      if File.exist?(target)
        return "#{label} is a directory; markdown and messages write one file" if kind == :file && File.directory?(target)
        return "#{label} is not a regular file (a FIFO, a socket, or a device), so it is not written" if kind == :file && !File.file?(target)
        return "#{label} is not a directory; allure writes a directory of results" if kind == :dir && !File.directory?(target)

        return nil
      end
      parent = File.dirname(target)
      parent = File.dirname(parent) until File.exist?(parent) || File.dirname(parent) == parent
      File.directory?(parent) ? nil : "#{label} lies under #{shown_path(parent)}, which is not a directory"
    end

    #: (String) -> String
    def shown_path(absolute)
      relative = Pathname.new(absolute).relative_path_from(Pathname.new(@project)).to_s
      relative == ".." || relative.start_with?("../") ? absolute : relative
    end

    # The files this project's own run noted in its exports manifest under
    # the export directory, so a render of the same run replaces what the
    # last one wrote there and retention removes them with the run. A run
    # that is not one of this project's own notes nothing.
    #: (String, untyped, Array[String]) -> Hash[Symbol, untyped]?
    def own_exports(dir, run_id, problems)
      runs = File.join(@project, ".nukadoko", "runs")
      return nil unless File.expand_path(dir) == File.join(runs, run_id.to_s) && !File.symlink?(dir)

      manifest = File.join(dir, "exports")
      if File.symlink?(manifest)
        problems << "exports of run #{run_id} resolves outside the run directory, so this render is not noted in it"
        return nil
      end
      export = File.join(@project, ".nukadoko", "export")
      lines = File.exist?(manifest) ? File.readlines(manifest, chomp: true).reject(&:empty?).uniq : []
      files = lines.map { [_1, File.expand_path(_1, @project)] }.select { |_, file| file.start_with?("#{export}/") && File.basename(file).casecmp("allure-history.jsonl") != 0 }
      { manifest: manifest, export: export, files: files }
    end

    #: (Hash[Symbol, untyped]?, String, Symbol) -> void
    def replace_own_exports(exports, target, kind)
      return unless exports

      gone = exports[:files].select { |_, file| kind == :file ? file == target : file.start_with?("#{target}/") }
      return if gone.empty?

      gone.each { |_, file| FileUtils.rm_f(file) }
      kept = File.readlines(exports[:manifest], chomp: true).reject { |entry| entry.empty? || gone.any? { |line, _| line == entry } }
      File.write(exports[:manifest], kept.map { "#{_1}\n" }.join)
    end

    #: (Hash[Symbol, untyped]?, Array[String]) -> void
    def note_own_exports(exports, files)
      return unless exports

      noted = files.select { _1.start_with?("#{exports[:export]}/") }
      File.open(exports[:manifest], "a") { |io| noted.each { io.puts Pathname.new(_1).relative_path_from(Pathname.new(@project)).to_s } } if noted.any?
    end

    #: () -> String
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
    #: () -> Integer
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

    #: (Engine::Refusal) -> Integer
    def refuse(refusal)
      finish(@command, false, findings: [refusal.to_h(@command)], verdict: refusal.severity, exit_code: refusal.exit_code)
    end

    #: (Engine::Finding) -> Engine::Finding
    def relative(finding)
      finding.with(file: finding.file&.delete_prefix("#{@project}/"))
    end

    # Every envelope opens the same way, in the TypeScript engine's order.
    #: (String?, String, Array[untyped], **untyped) -> Hash[Symbol, untyped]
    def head(command, verdict, findings, **more)
      { schema_version: Engine::RunRecord::SCHEMA_VERSION, nukadoko: VERSION, command: command, **more, verdict: verdict, findings: findings }
    end

    #: (String?, bool, findings: Array[untyped], ?verdict: String, ?exit_code: Integer, **untyped) -> Integer
    def finish(command, passed, findings:, verdict: passed ? "passed" : "failed", exit_code: passed ? 0 : 1, **rest)
      # What a walk that stops here ends with.
      @stopped_with = findings
      emit({ **head(command, verdict, findings), **rest }, findings, command)
      exit_code
    end

    #: (Hash[Symbol, untyped], Array[untyped], String?, ?io: IO) -> void
    def emit(envelope, findings, command, io: @out)
      if @json
        @out.puts JSON.pretty_generate(envelope)
      else
        findings.each do |f|
          io.puts [f[:severity], f[:code], Engine::Summary.where_of(f), f[:message]].join("\t")
          io.puts "  fix: #{f[:fix]}" if f[:fix]
          io.puts "  do: #{f[:do]}" if f[:do]
        end
        io.puts "ok: no issues found" if command == "check" && findings.empty?
      end
    end

    # The counts after where the run wrote, as the TypeScript engine prints
    # them: the scenarios, then the control runs, then the criteria when a
    # control or a base makes the scenario count no verdict count, then the
    # criteria left out.
    #: (Hash[Symbol, untyped], IO) -> void
    def run_end(envelope, io)
      counts = envelope[:counts] #: Hash[Symbol, Integer]
      total = counts[:scenarios]
      stopped = counts[:stopped]
      io.puts "#{total} scenario#{total == 1 ? "" : "s"}: #{counts[:passed]} passed, #{total - counts[:passed] - stopped} failed" \
              "#{stopped.positive? ? ", #{stopped} stopped" : ""}#{counts[:not_run].positive? ? ", #{counts[:not_run]} not run" : ""}" \
              "  (#{duration(envelope[:started_at], envelope[:finished_at])})"
      if counts[:controls].positive? || counts[:controls_not_run].positive?
        not_run = counts[:controls_not_run].positive? ? ", #{counts[:controls_not_run]} not run" : ""
        io.puts "#{counts[:controls]} control run#{counts[:controls] == 1 ? "" : "s"}#{not_run}"
      end
      table = envelope[:table] #: Hash[Symbol, untyped]
      rows = table[:rows] #: Array[Hash[Symbol, untyped]]
      based = !table[:base].nil?
      if based || counts[:controls].positive?
        count = ->(word) { rows.count { _1[:verdict] == word } }
        extra = based ? ", #{count.("unproven")} unproven, #{count.("moved")} moved, #{count.("removed")} removed" : ""
        io.puts "criteria: #{count.("held")} held, #{count.("proven")} proven, #{count.("failed")} failed#{extra}"
      end
      left_out = table[:left_out].to_i
      return unless left_out.positive?

      io.puts left_out == 1 ? "1 criterion not run: its conditions hold in no selected environment" : "#{left_out} criteria not run: their conditions hold in no selected environment"
    end

    # `1h 2m 3s`, the unit a whole run reads in.
    #: (String, String) -> String
    def duration(started_at, finished_at)
      total = [(Time.iso8601(finished_at) - Time.iso8601(started_at)).round, 0].max
      hours, rest = total.divmod(3600)
      minutes, seconds = rest.divmod(60)
      [*(hours.positive? ? ["#{hours}h"] : []), *(hours.positive? || minutes.positive? ? ["#{minutes}m"] : []), "#{seconds}s"].join(" ")
    end

    # After the failed list, under --repeat, each scenario that failed at
    # least once and how many of its executions passed. No verdict is
    # named: one that fails every time is not flaky.
    #: (Array[Hash[Symbol, untyped]], IO) -> void
    def repeat_tallies(scenarios, io)
      named = @options["--env"].size > 1
      scenarios.reject { _1[:world] }.group_by { _1.values_at(:feature, :line, :environment) }.each_value do |runs|
        passed = runs.count { _1[:status] == "passed" }
        next if passed == runs.size

        first = runs.first
        name = named ? "#{first[:scenario]} (#{first[:environment]})" : first[:scenario]
        io.puts "repeat  #{first[:feature]}:#{first[:line]}  #{name}  #{passed} of #{runs.size} passed"
      end
    end
  end
end
