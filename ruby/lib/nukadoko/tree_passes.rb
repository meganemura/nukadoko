# frozen_string_literal: true

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
module Nukadoko
  module Engine
    class TreePasses
      EXE = File.expand_path("../../exe/nuka", __dir__)
      LIB = File.expand_path("..", __dir__)

      def initialize(base, scenarios, head_cells, environments, dir, out)
        @base = base
        @scenarios = scenarios
        @head_cells = head_cells
        @environments = environments
        @old_environments = base.old_environments || environments
        @dir = dir
        @out = out
      end

      # Appends each tree execution to `executions`, and returns each row's
      # base and old cells by its scenario.
      def call(executions)
        planned = @scenarios.to_h { [_1, plan(_1)] }
        found = {}
        [["base", @base.base_root, @environments], ["old", @base.old_root, @old_environments]].each do |world, root, environments|
          environments.each do |environment|
            rows = @scenarios.select { planned[_1][world.to_sym].include?(environment.name) }
            next if rows.empty?

            outcome = root ? run_tree(world, root, environment, rows) : { not_run: "the #{world} world was not made" }
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

      def plan(scenario)
        change = @base.changes[Criteria.key(scenario.uri, scenario.line)]
        context = change && { change: change[:change], held: scenario.tags.include?(Criteria::HELD), mapping_changed: @base.mapping[:changed],
                              retagged: change[:retagged] == true, renamed: !change[:renamed_from].nil? }
        tags = Table.condition_tags(scenario.tags)
        old_roles = @old_environments.map { { environment: _1.name, role: Table.role(tags, _1.conditions) } }
        RunRecord.planned_world_cells(@head_cells[scenario], context, old_roles)
      end

      # Where a tree runs a head row: at its own place in the base tree,
      # which holds head's features, and at the ref's place in the old one.
      def place(world, scenario)
        return [scenario.uri, scenario.line] if world == "base"

        @base.at(Criteria.key(scenario.uri, scenario.line)).values_at(:feature, :line)
      end

      def cell(scenario, world, environment, found)
        role = world == "base" ? (@head_cells[scenario].find { _1[:environment] == environment.name }&.dig(:role) || "required") : "required"
        conditions = Table.conditions_of(scenario.tags, environment.conditions)
        own = found[:cell]
        return { world: world, environment: environment.name, role: role, conditions: conditions, outcome: "not-run", runs: 0, reason: found[:reason] } unless own

        { **own, world: world, environment: environment.name, role: role, conditions: conditions }
      end

      def run_tree(world, root, environment, rows)
        plan = File.join(@dir, "trees", "#{world}-#{environment.name}.plan.json")
        result = File.join(@dir, "trees", "#{world}-#{environment.name}.result.json")
        targets = rows.map { |scenario| place(world, scenario).then { { feature: _1, line: _2 } } }
        File.write(plan, JSON.generate(world: world, environment: environment.name, targets: targets, dir: @dir, result: result))
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
