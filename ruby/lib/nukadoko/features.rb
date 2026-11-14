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
    Scenario = Data.define(:uri, :line, :keyword_line, :name, :tags, :steps, :tag_lines, :columns, :outline_name, :serial)
    PickleStep = Data.define(:text, :line, :kind, :table, :doc_string, :background)
    # What makes a file, or a part of one, run nothing: a file that does
    # not parse, or an outline with no row to run. `line` is nil for a file.
    FeatureProblem = Data.define(:code, :uri, :line, :message)

    # A directory is every .feature file under it; a list is those files.
    # What runs nothing goes into `problems`, for nuka check to report.
    def self.load_features(dir_or_paths, problems: [])
      paths = dir_or_paths.is_a?(Array) ? dir_or_paths : Dir.glob(File.join(dir_or_paths, "**/*.feature")).sort
      return [] if paths.empty?

      lines = {}
      background = {}
      headers = {}
      names = {}
      serial = {}
      scenarios = []
      parse_errors = Hash.new { |h, k| h[k] = [] }
      Gherkin.from_paths(paths, include_source: false, include_gherkin_document: true, include_pickles: true).each do |envelope|
        if (error = envelope.parse_error)
          parse_errors[error.source.uri] << error.message
        elsif (doc = envelope.gherkin_document)
          if doc.feature
            collect_lines(doc.feature, lines, background, headers, names)
            serial[doc.uri] = doc.feature.tags.any? { _1.name == SERIAL_TAG }
            problems.concat(serial_tags_on_scenarios(doc))
            problems.concat(outlines_that_do_not_run(doc))
          end
        elsif (pickle = envelope.pickle)
          steps = pickle.steps.map do |step|
            table = step.argument&.data_table&.rows&.map { |row| row.cells.map(&:value) }
            PickleStep.new(step.text, lines.fetch(step.ast_node_ids.first), step.type, table, step.argument&.doc_string&.content,
                           background.key?(step.ast_node_ids.first))
          end
          scenarios << Scenario.new(pickle.uri, lines.fetch(pickle.ast_node_ids.last), lines.fetch(pickle.ast_node_ids.first),
                                    pickle.name, pickle.tags.map(&:name), steps,
                                    pickle.tags.to_h { [_1.name, lines[_1.ast_node_id]] }, headers.fetch(pickle.ast_node_ids.last, []),
                                    names.fetch(pickle.ast_node_ids.first, pickle.name), serial.fetch(pickle.uri, false))
        end
      end
      # One finding per file, every error in the parser's words and order.
      parse_errors.each { |uri, messages| problems << FeatureProblem.new("feature-parse-error", uri, nil, "Parser errors:\n#{messages.join("\n")}") }
      scenarios
    end

    # The tag on a Feature line that runs the file while no other file runs.
    SERIAL_TAG = "@nukadoko:serial"

    # nuka run --concurrency reads the serial tag on the Feature line only,
    # so on a scenario it would read as a rule in force while doing nothing.
    def self.serial_tags_on_scenarios(doc)
      scenarios = doc.feature.children.flat_map { |child| child.rule ? child.rule.children.filter_map(&:scenario) : [child.scenario].compact }
      scenarios.select { |scenario| scenario.tags.any? { _1.name == SERIAL_TAG } }.map do |scenario|
        FeatureProblem.new("serial-tag-on-scenario", doc.uri, scenario.location.line,
                           %(@nukadoko:serial on scenario "#{scenario.name}" has no effect: nuka run --concurrency reads @nukadoko:serial only from the Feature line. Move the tag there.))
      end
    end

    # An outline with no Examples runs its placeholder text as written, and
    # an Examples table with no rows leaves the outline out of the run.
    def self.outlines_that_do_not_run(doc)
      outline = Gherkin::Dialect.for(doc.feature.language).scenario_outline_keywords
      scenarios = doc.feature.children.flat_map { |child| child.rule ? child.rule.children.filter_map(&:scenario) : [child.scenario].compact }
      scenarios.flat_map do |scenario|
        if scenario.examples.empty?
          next [] unless outline.include?(scenario.keyword)

          next [FeatureProblem.new("outline-does-not-run", doc.uri, scenario.location.line,
                                   %(Scenario outline "#{scenario.name}" has no Examples table, so the placeholder text runs as written. Add one Examples row for each boundary that must run.))]
        end
        scenario.examples.select { _1.table_body.empty? }.map do |block|
          FeatureProblem.new("outline-does-not-run", doc.uri, block.location.line,
                             %(Scenario "#{scenario.name}" has an Examples table with no rows, so the scenario is left out of the run. Add a row, or remove the table.))
        end
      end
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
