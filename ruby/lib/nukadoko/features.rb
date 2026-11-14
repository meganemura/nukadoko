# frozen_string_literal: true

require "gherkin"

# Feature files become pickles through the official gherkin gem. Each pickle
# keeps the line of its scenario and of each step, which every finding and
# record names.
module Nukadoko
  module Engine
    Scenario = Data.define(:uri, :line, :name, :steps)
    PickleStep = Data.define(:text, :line, :table)

    def self.load_features(dir)
      paths = Dir.glob(File.join(dir, "**/*.feature")).sort
      lines = {}
      scenarios = []
      Gherkin.from_paths(paths, include_source: false, include_gherkin_document: true, include_pickles: true).each do |envelope|
        if (doc = envelope.gherkin_document)
          collect_lines(doc.feature, lines)
        elsif (pickle = envelope.pickle)
          steps = pickle.steps.map do |step|
            table = step.argument&.data_table&.rows&.map { |row| row.cells.map(&:value) }
            PickleStep.new(step.text, lines.fetch(step.ast_node_ids.first), table)
          end
          scenarios << Scenario.new(pickle.uri, lines.fetch(pickle.ast_node_ids.first), pickle.name, steps)
        end
      end
      scenarios
    end

    def self.collect_lines(node, lines)
      node.children.each do |child|
        scenario = child.scenario || child.background
        next collect_lines(child.rule, lines) if child.rule
        next unless scenario

        lines[scenario.id] = scenario.location.line if child.scenario
        scenario.steps.each { |step| lines[step.id] = step.location.line }
      end
    end
  end
end
