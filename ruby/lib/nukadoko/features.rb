# frozen_string_literal: true

require "gherkin"

# Feature files become pickles through the official gherkin gem. A pickle
# from an outline is named by its Examples row's line, and its steps by the
# outline's step lines, as the TypeScript engine names them.
module Nukadoko
  module Engine
    # `keyword_line` is the Scenario keyword's own line, the same for every
    # row of an outline, and `outline_name` the name as written, before a
    # row fills it. A step from a Background has `background` set.
    Scenario = Data.define(:uri, :line, :keyword_line, :name, :tags, :steps, :tag_lines, :columns, :outline_name)
    PickleStep = Data.define(:text, :line, :kind, :table, :doc_string, :background)

    # A directory is every .feature file under it; a list is those files.
    def self.load_features(dir_or_paths)
      paths = dir_or_paths.is_a?(Array) ? dir_or_paths : Dir.glob(File.join(dir_or_paths, "**/*.feature")).sort
      return [] if paths.empty?

      lines = {}
      background = {}
      headers = {}
      names = {}
      scenarios = []
      Gherkin.from_paths(paths, include_source: false, include_gherkin_document: true, include_pickles: true).each do |envelope|
        if (doc = envelope.gherkin_document)
          collect_lines(doc.feature, lines, background, headers, names) if doc.feature
        elsif (pickle = envelope.pickle)
          steps = pickle.steps.map do |step|
            table = step.argument&.data_table&.rows&.map { |row| row.cells.map(&:value) }
            PickleStep.new(step.text, lines.fetch(step.ast_node_ids.first), step.type, table, step.argument&.doc_string&.content,
                           background.key?(step.ast_node_ids.first))
          end
          scenarios << Scenario.new(pickle.uri, lines.fetch(pickle.ast_node_ids.last), lines.fetch(pickle.ast_node_ids.first),
                                    pickle.name, pickle.tags.map(&:name), steps,
                                    pickle.tags.to_h { [_1.name, lines[_1.ast_node_id]] }, headers.fetch(pickle.ast_node_ids.last, []),
                                    names.fetch(pickle.ast_node_ids.first, pickle.name))
        end
      end
      scenarios
    end

    def self.collect_lines(node, lines, background, headers, names)
      node.tags&.each { lines[_1.id] = _1.location.line }
      node.children.each do |child|
        next collect_lines(child.rule, lines, background, headers, names) if child.rule

        scenario = child.scenario || child.background
        next unless scenario

        names[scenario.id] = scenario.name if child.scenario
        lines[scenario.id] = scenario.location.line if child.scenario
        scenario.steps.each { |step| lines[step.id] = step.location.line }
        child.background&.steps&.each { |step| background[step.id] = true }
        child.scenario&.tags&.each { lines[_1.id] = _1.location.line }
        child.scenario&.examples&.each do |examples|
          examples.tags.each { lines[_1.id] = _1.location.line }
          columns = examples.table_header&.cells&.map(&:value) || []
          examples.table_body.each do |row|
            lines[row.id] = row.location.line
            headers[row.id] = columns
          end
        end
      end
    end
  end
end
