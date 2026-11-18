# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "open3"
require "rbconfig"

# The base and the old world's passes of a `--base` run. Each row plans the
# cells its verdict needs from its head cells (RunRecord.planned_world_cells),
# and each tree runs its planned rows one environment at a time, in a
# process of its own started in the tree: a step file is loaded into the
# process that runs it, and head's steps are already loaded in this one.
# The pass writes its step records into the head run's directory, and its
# executions and cells come back as JSON. A cell whose pass did not run
# says why.
#
# Where both programs name {events}, the base world also runs, once and
# for run.json's `paths` alone, each row whose head cell is required and
# ran and that no base cell runs, so a criterion that did not change still
# shows what the code change did to its path. Such an execution carries
# `for_paths` and is no cell, so the table, the proof runs, and the
# verdicts never read it.
module Nukadoko
  module Engine
    class TreePasses
      EXE = File.expand_path("../../exe/nuka", __dir__.to_s)
      LIB = File.expand_path("..", __dir__.to_s)

      # `judged_by` says why head's passing executions of a row judged no
      # claim in Then position (Run.then_judged_by).
      # `writes_events` says whether head's world of an environment writes
      # execution events.
      #: (Base, Array[Scenario], Hash[Scenario, Array[Hash[Symbol, untyped]]], Array[Environment], String, IO, ?^(Scenario) -> untyped, ?head_root: String, ?writes_events: ^(Environment) -> bool, ?own_fields: Hash[String, Array[String]]) -> void
      def initialize(base, scenarios, head_cells, environments, dir, out, judged_by = ->(_) {}, head_root: Dir.pwd, writes_events: ->(_) { false }, own_fields: {})
        @head_root = head_root
        @own_fields = own_fields
        @writes_events = writes_events
        @judged_by = judged_by
        @base = base
        @scenarios = scenarios
        @head_cells = head_cells
        @environments = environments
        @old_environments = base.old_environments || environments
        @dir = dir
        @out = out
        @worlds = []
      end

      # The worlds each tree's passes started, as run.json names them.
      attr_reader :worlds

      # Appends each tree execution to `executions`, and returns each row's
      # base and old cells by its scenario.
      #: (Array[Hash[Symbol, untyped]]) -> Hash[Scenario, Array[Hash[Symbol, untyped]]]
      def call(executions)
        planned = @scenarios.to_h { [_1, plan(_1)] }
        found = {}
        [["base", @base.base_root, @environments], ["old", @base.old_root, @old_environments]].each do |world, root, environments|
          environments.each do |environment|
            rows = @scenarios.select { planned[_1][world.to_sym].include?(environment.name) }
            paths = world == "base" && @writes_events.(environment) ? @scenarios.select { !rows.include?(_1) && ran_required?(_1, environment) } : []
            next if rows.empty? && (paths.empty? || root.nil?)

            outcome = (root ? run_tree(world, root, environment, rows, paths) : { not_run: "the #{world} world was not made" }) #: Hash[Symbol, untyped]
            @worlds.concat(outcome[:worlds] || [])
            paths.each do |scenario|
              result = outcome[:results]&.find { |entry| [entry[:feature], entry[:line]] == place(world, scenario) }
              came = result&.dig(:cell)
              result&.dig(:executions)&.each do |json|
                json.delete(:do)
                json.merge!(role: "required", world: world, row: { feature: scenario.uri, line: scenario.line },
                            for_paths: { outcome: came&.dig(:outcome), line: came&.dig(:line) }.compact)
                executions << { json: json }
              end
            end
            rows.each do |scenario|
              result = outcome[:results]&.find { |entry| [entry[:feature], entry[:line]] == place(world, scenario) }
              found[[scenario, world, environment.name]] = result || { reason: outcome[:not_run] || "no execution of it was recorded" }
              result&.dig(:executions)&.each do |json|
                json.delete(:do)
                json.merge!(role: "required", world: world, row: { feature: scenario.uri, line: scenario.line })
                executions << { json: json }
              end
            end
          end
        end
        @scenarios.to_h do |scenario|
          cells = [["base", @environments], ["old", @old_environments]].flat_map do |world, environments|
            environments.select { planned[scenario][world.to_sym].include?(_1.name) }.map { cell(scenario, world, _1, found[[scenario, world, _1.name]]) }
          end
          [scenario, cells]
        end
      end

      private

      # Whether head's cell of a row in an environment is required and ran.
      #: (Scenario, Environment) -> bool
      def ran_required?(scenario, environment)
        cell = @head_cells[scenario].find { _1[:environment] == environment.name }
        !cell.nil? && cell[:role] == "required" && cell[:outcome] != "not-run"
      end

      #: (Scenario) -> Hash[Symbol, Array[String]]
      def plan(scenario)
        change = @base.changes[Criteria.key(scenario.uri, scenario.line)]
        context = change && { change: change[:change], held: scenario.tags.include?(Criteria::HELD), mapping_changed: @base.mapping[:changed],
                              retagged: change[:retagged] == true, renamed: !change[:renamed_from].nil?, then_judges_no_claim: @judged_by.(scenario) }
        tags = Table.condition_tags(scenario.tags)
        old_roles = @old_environments.map { { environment: _1.name, role: Table.role(tags, _1.conditions) } }
        RunRecord.planned_world_cells(@head_cells[scenario], context, old_roles)
      end

      # Where a tree runs a head row: at its own place in the base tree,
      # which holds head's features, and at the ref's place in the old one.
      #: (String, Scenario) -> Array[untyped]
      def place(world, scenario)
        return [scenario.uri, scenario.line] if world == "base"

        @base.at(Criteria.key(scenario.uri, scenario.line)).values_at(:feature, :line)
      end

      #: (Scenario, String, Environment, Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def cell(scenario, world, environment, found)
        role = world == "base" ? (@head_cells[scenario].find { _1[:environment] == environment.name }&.dig(:role) || "required") : "required"
        conditions = Table.conditions_of(scenario.tags, environment.conditions)
        own = found[:cell]
        return { world: world, environment: environment.name, role: role, conditions: conditions, outcome: "not-run", runs: 0, reason: found[:reason] } unless own

        { **own, world: world, environment: environment.name, role: role, conditions: conditions }
      end

      # `paths` are the rows the tree runs for paths alone, which its pass
      # drops when the tree's own program names no {events}.
      #: (String, String, Environment, Array[Scenario], ?Array[Scenario]) -> Hash[Symbol, untyped]
      def run_tree(world, root, environment, rows, paths = [])
        plan = File.join(@dir, "trees", "#{world}-#{environment.name}.plan.json")
        result = File.join(@dir, "trees", "#{world}-#{environment.name}.result.json")
        targets = rows.map { |scenario| place(world, scenario).then { { feature: _1, line: _2 } } }
        for_paths = paths.map { |scenario| place(world, scenario).then { { feature: _1, line: _2 } } }
        config = Nukadoko.config_options.fetch(:secrets, {}) #: Hash[Symbol, untyped]
        head = { root: File.expand_path(@head_root), env_files: environment.env_files, public: (config[:public] || []).map(&:to_s), redact: (config[:redact] || []).map(&:to_s),
                 own_fields: @own_fields }
        File.write(plan, JSON.generate(world: world, environment: environment.name, targets: targets, for_paths: for_paths, dir: @dir, result: result, head: head))
        output, status = Open3.capture2e(RbConfig.ruby, "-I", LIB, EXE, "__tree", plan, chdir: root)
        @out.write(output.gsub(@dir, File.join(".nukadoko", "runs", File.basename(@dir))))
        return JSON.parse(File.read(result), symbolize_names: true) if File.exist?(result)

        { not_run: "the #{world} world's pass ended with exit #{status.exitstatus} before it recorded a result: #{output.lines.last.to_s.strip}" }
      ensure
        FileUtils.rm_f([plan, result].compact)
      end
    end
  end
end
