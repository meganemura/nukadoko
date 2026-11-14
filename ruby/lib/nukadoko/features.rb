# frozen_string_literal: true

require "gherkin"

# Feature files become pickles through the official gherkin gem. A pickle
# from an outline is named by its Examples row's line, and its steps by the
# outline's step lines, as the TypeScript engine names them.
module Nukadoko
  module Engine
    Scenario = Data.define(:uri, :line, :name, :tags, :steps)
    PickleStep = Data.define(:text, :line, :kind, :table, :doc_string)

    def self.load_features(dir)
      paths = Dir.glob(File.join(dir, "**/*.feature")).sort
      lines = {}
      scenarios = []
      Gherkin.from_paths(paths, include_source: false, include_gherkin_document: true, include_pickles: true).each do |envelope|
        if (doc = envelope.gherkin_document)
          collect_lines(doc.feature, lines) if doc.feature
        elsif (pickle = envelope.pickle)
          steps = pickle.steps.map do |step|
            table = step.argument&.data_table&.rows&.map { |row| row.cells.map(&:value) }
            PickleStep.new(step.text, lines.fetch(step.ast_node_ids.first), step.type, table, step.argument&.doc_string&.content)
          end
          scenarios << Scenario.new(pickle.uri, lines.fetch(pickle.ast_node_ids.last), pickle.name, pickle.tags.map(&:name), steps)
        end
      end
      scenarios
    end

    def self.collect_lines(node, lines)
      node.children.each do |child|
        next collect_lines(child.rule, lines) if child.rule

        scenario = child.scenario || child.background
        next unless scenario

        lines[scenario.id] = scenario.location.line if child.scenario
        scenario.steps.each { |step| lines[step.id] = step.location.line }
        child.scenario&.examples&.each { |examples| examples.table_body.each { |row| lines[row.id] = row.location.line } }
      end
    end
  end
end
