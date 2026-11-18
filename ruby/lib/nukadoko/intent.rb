# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# Responsibility: the intent file's format (docs/intent.md): what a change
# declares it means to do differently, as one Markdown table whose rows
# are target x observation x before -> after, each cell in the execution
# events vocabulary. Reading it, writing it back, and the two questions a
# row answers about one entry of a path: does the row aim at it, and does
# a difference on it go the way the row says. Pure. Boundary: where the
# file is and what git says of it are IntentFile's; which criteria a row
# reached, and what each came to, are IntentView's.
#
# Only the table whose header is exactly
# `| Target | Observation | Before | After |` is read; prose around it is
# for people. A cell's terms are the events vocabulary: a kind, and
# `field<op>value` over a line's fields, so a row names what the program
# reports and never a step, a criterion's text, or an id.
#
# A value is JSON when it parses as JSON and is otherwise the bare text:
# `plan:team` and `"plan:team"` are one value, and `10` is a number. A
# term ends at a space outside a JSON string or brackets, so a value with
# spaces is written as JSON, and a `|` in a cell is written `\|`, as
# Markdown has it.
#
# Before and after say how many lines a step's path counts for an
# observation with no bare field (`0` -> `1`), or which value the bare
# field had. Both left empty says the observation is not meant to change
# at all, which is how a refactor declares that decisions stay as they
# were. A row that cannot be read is a problem named by its line, never
# left out in silence.
module Nukadoko
  module Engine
    module Intent
      FILE = "INTENT.md"
      HEADER = %w[Target Observation Before After].freeze
      OPS = %w[>= <= != = > <].freeze
      FIELD = /\A[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\z/

      module_function

      # The cells of a Markdown table line: between its outer pipes, split
      # at each `|` that `\` does not escape, each trimmed, `\|` read as `|`.
      #: (String) -> Array[String]?
      def table_cells(line)
        text = line.strip
        return nil if !text.start_with?("|") || !text.end_with?("|") || text.size < 2 || text.end_with?("\\|")

        cells = [] #: Array[String]
        cell = +""
        index = 1
        while index < text.size - 1
          char = text[index]
          if char == "\\" && text[index + 1] == "|"
            cell << "|"
            index += 1
          elsif char == "|"
            cells << cell.strip
            cell = +""
          else
            cell << char.to_s
          end
          index += 1
        end
        cells << cell.strip
      end

      # A cell as a table line holds it: `|` escaped.
      #: (String) -> String
      def cell_text(value) = value.gsub("|", "\\|")

      # The terms of a cell, split at each run of spaces outside a JSON
      # string and outside brackets.
      #: (String) -> Array[String]
      def split_terms(text)
        terms = [] #: Array[String]
        term = +""
        depth = 0
        quoted = false
        chars = text.chars
        index = 0
        while index < chars.size
          char = chars.fetch(index)
          if quoted
            term << char
            if char == "\\"
              term << (chars[index + 1] || "")
              index += 1
            elsif char == '"'
              quoted = false
            end
            index += 1
            next
          end
          if char == '"' then quoted = true
          elsif "[{".include?(char) then depth += 1
          elsif "]}".include?(char) && depth.positive? then depth -= 1
          end
          if char.match?(/\s/) && depth.zero?
            terms << term unless term.empty?
            term = +""
          else
            term << char
          end
          index += 1
        end
        terms << term unless term.empty?
        terms
      end

      # A value as written: JSON when it parses, the bare text otherwise.
      #: (String) -> untyped
      def value_of(text)
        JSON.parse(text)
      rescue JSON::ParserError
        text
      end

      # A value as a cell writes it: bare when that reads back as the same
      # value and holds no space, pipe, quote, or bracket, and JSON
      # otherwise.
      #: (untyped) -> String
      def value_text(value)
        return value if value.is_a?(String) && !value.empty? && !value.match?(/[\s|"\[\]{}]/) && value_of(value) == value

        JSON.generate(value)
      end

      #: (String) -> Hash[Symbol, untyped]
      def term_of(text)
        return { bare: text } if FIELD.match?(text)

        (1...text.size).each do |index|
          op = OPS.find { text[index, _1.size] == _1 }
          next if op.nil?

          field = text[0, index].to_s
          break unless FIELD.match?(field)

          value = text[(index + op.size)..].to_s
          return { problem: "`#{text}` has no value after `#{op}`" } if value.empty?

          return { field: field, op: op, value: value_of(value) }
        end
        { problem: "`#{text}` is neither a field nor `field<op>value` with one of #{OPS.map { "`#{_1}`" }.join(", ")}" }
      end

      # Why a field cannot be read on a kind's lines, or nil.
      #: (String, String) -> String?
      def field_problem(kind, field)
        if Events.own_kind?(kind)
          return field.start_with?(Events::EXTENSION_PREFIX) ? nil : "a #{kind} line is read only at a field of its own, which starts with `#{Events::EXTENSION_PREFIX}`, not at `#{field}`"
        end

        fields = Events::PATH_KINDS.fetch(kind)[:fields]
        fields.include?(field) ? nil : "a path keeps a `#{kind}` line by #{fields.map { "`#{_1}`" }.join(", ")}, not by `#{field}`"
      end

      # A term as a path's key reads it: an `http` origin on loopback
      # without its port, as a path keeps it.
      #: (String, Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def key_term(kind, term)
        return term unless kind == "http" && term[:field] == "origin" && term[:value].is_a?(String)

        term.merge(value: Events.path_origin(term[:value]))
      end

      #: (String) -> Integer?
      def count_of(text) = text.match?(/\A(?:0|[1-9][0-9]*)\z/) ? text.to_i : nil

      #: (Integer, Integer, Hash[Symbol, String]) -> Hash[Symbol, untyped]
      def row_of(row, line, cells)
        problem = ->(message) { { line: line, message: "row #{row}: #{message}" } }
        tags = [] #: Array[String]
        targets = [] #: Array[String]
        split_terms(cells[:target].to_s).each { _1.match?(/\A@\S+\z/) ? tags << _1 : targets << _1 }
        kind, *observed = split_terms(cells[:observation].to_s)
        return problem.("the observation names no kind of line") if kind.nil?
        unless Events.own_kind?(kind) || Events::PATH_KINDS.key?(kind)
          return problem.("`#{kind}` is not a kind a path keeps: one of #{Events::PATH_KINDS.keys.map { "`#{_1}`" }.join(", ")}, " \
                          "or a writer's own kind that starts with `#{Events::EXTENSION_PREFIX}`")
        end

        conditions = [] #: Array[Hash[Symbol, untyped]]
        targets.each do |text|
          term = term_of(text)
          return problem.(term[:problem]) if term[:problem]
          return problem.("the target term `#{text}` names a field with no value; a target is tags and `field<op>value` terms") if term[:bare]

          conditions << key_term(kind, term)
        end
        filters = [] #: Array[Hash[Symbol, untyped]]
        projections = [] #: Array[String]
        observed.each do |text|
          term = term_of(text)
          return problem.(term[:problem]) if term[:problem]

          term[:bare] ? projections << term[:bare] : filters << key_term(kind, term)
        end
        if projections.size > 1
          return problem.("the observation names #{projections.size} fields with no value (#{projections.map { "`#{_1}`" }.join(", ")}); it observes at most one")
        end

        [*conditions.map { _1[:field] }, *filters.map { _1[:field] }, *projections].each do |field|
          why = field_problem(kind, field)
          return problem.(why) if why
        end
        if kind == "db" && (conditions + filters).any? { _1[:field] == "op" && _1[:op] == "=" && _1[:value] == "read" }
          return problem.("a path keeps no database read, so `op=read` matches nothing")
        end

        projection = projections.first
        read = { row: row, line: line, cells: cells, tags: tags, conditions: conditions, kind: kind, filters: filters, projection: projection }
        return read.merge(change: nil) if cells[:before].to_s.empty? && cells[:after].to_s.empty?
        return problem.("before and after are both empty, for no change, or both filled") if cells[:before].to_s.empty? || cells[:after].to_s.empty?

        if projection.nil?
          before = count_of(cells[:before].to_s)
          after = count_of(cells[:after].to_s)
          if before.nil? || after.nil?
            return problem.("an observation with no field to read counts lines, so before and after are whole numbers, not `#{cells[:before]}` and `#{cells[:after]}`")
          end
          return problem.("before and after are both #{before}; leave both empty for no change") if before == after

          return read.merge(change: { before: before, after: after })
        end
        before = value_of(cells[:before].to_s)
        after = value_of(cells[:after].to_s)
        return problem.("before and after are the same value; leave both empty for no change") if same_value?(before, after)

        read.merge(change: { before: before, after: after })
      end

      # Reads the intent file's text: `{ rows:, problems: }`. Pure.
      #: (String) -> Hash[Symbol, Array[Hash[Symbol, untyped]]]
      def parse(text)
        lines = text.split(/\r?\n/, -1)
        start = lines.index { (cells = table_cells(_1)) && cells == HEADER }
        return { rows: [], problems: [{ line: nil, message: "no table has the header `| #{HEADER.join(" | ")} |`" }] } if start.nil?

        rows = [] #: Array[Hash[Symbol, untyped]]
        problems = [] #: Array[Hash[Symbol, untyped]]
        delimiter = table_cells(lines[start + 1] || "")
        if delimiter.nil? || delimiter.size != HEADER.size || !delimiter.all? { _1.match?(/\A:?-+:?\z/) }
          return { rows: rows, problems: [{ line: start + 2, message: "the header is not followed by a delimiter row such as `| --- | --- | --- | --- |`" }] }
        end

        row = 0
        ((start + 2)...lines.size).each do |index|
          cells = table_cells(lines.fetch(index))
          break if cells.nil?

          row += 1
          if cells.size != HEADER.size
            problems << { line: index + 1, message: "row #{row}: has #{cells.size} cells, not #{HEADER.size}" }
            next
          end
          target, observation, before, after = cells
          read = row_of(row, index + 1, { target: target.to_s, observation: observation.to_s, before: before.to_s, after: after.to_s })
          read.key?(:kind) ? rows << read : problems << read
        end
        { rows: rows, problems: problems }
      end

      # The table a list of rows' cells makes, header first: what `parse`
      # reads back to the same cells.
      #: (Array[Hash[Symbol, String]]) -> String
      def table(rows)
        line = ->(cells) { "| #{cells.map { cell_text(_1) }.join(" | ")} |" }
        [line.(HEADER), line.(HEADER.map { "---" }), *rows.map { line.(_1.values_at(:target, :observation, :before, :after).map(&:to_s)) }].join("\n")
      end

      # For each writer's own kind a row observes, every field a row reads
      # on it, so a path counts the kind by them.
      #: (Hash[Symbol, untyped]) -> Hash[String, Array[String]]
      def own_fields(intent)
        fields = {} #: Hash[String, Array[String]]
        intent[:rows].each do |row|
          next unless Events.own_kind?(row[:kind])

          named = fields[row[:kind]] ||= []
          [*row[:conditions].map { _1[:field] }, *row[:filters].map { _1[:field] }, *row[:projection]].each { named << _1 unless named.include?(_1) }
        end
        fields.transform_values(&:sort)
      end

      # Two values are one when their JSON is, objects' keys in any order.
      #: (untyped, untyped) -> bool
      def same_value?(one, other) = canonical(one) == canonical(other)

      #: (untyped) -> String
      def canonical(value)
        case value
        when Array then "[#{value.map { canonical(_1) }.join(",")}]"
        when Hash then "{#{value.sort_by { |key, _| key.to_s }.map { |key, inner| "#{JSON.generate(key.to_s)}:#{canonical(inner)}" }.join(",")}}"
        else JSON.generate(value)
        end
      end

      # The value a key or a line holds at a field: a path's own key holds
      # a dotted field as one name, a line as nested objects. `nil` with
      # `found: false` when it holds none.
      #: (Hash[String, untyped], String) -> [bool, untyped]
      def field_value(record, field)
        return [true, record[field]] if record.key?(field)

        value = record
        field.split(".").each do |segment|
          return [false, nil] unless value.is_a?(Hash) && value.key?(segment)

          value = value[segment]
        end
        [true, value]
      end

      # Whether a term holds on a record. A field the record lacks meets no
      # term, and an order compares two numbers or two strings alone.
      #: (Hash[Symbol, untyped], Hash[String, untyped]) -> bool
      def term_holds?(term, record)
        found, value = field_value(record, term[:field])
        return false unless found

        expected = term[:value]
        return same_value?(value, expected) if term[:op] == "="
        return !same_value?(value, expected) if term[:op] == "!="
        return false unless (value.is_a?(Numeric) && expected.is_a?(Numeric)) || (value.is_a?(String) && expected.is_a?(String))

        case term[:op]
        when "<" then value < expected
        when "<=" then value <= expected
        when ">" then value > expected
        else value >= expected
        end
      end

      # Whether a row aims at an entry of a path: its kind, and every
      # condition and filter holds on it.
      #: (Hash[Symbol, untyped], Hash[String, untyped]) -> bool
      def observes?(row, key) = key["kind"] == row[:kind] && (row[:conditions] + row[:filters]).all? { term_holds?(_1, key) }

      #: (Hash[Symbol, untyped], Integer) -> bool
      def within?(range, count) = range[:at_least] <= count && (range[:at_most].nil? || count <= range[:at_most])

      # Whether a difference on an entry the row observes goes the way the
      # row says. For a count: the base side can hold `before` and head
      # `after`. For a value: the entry holds `before` and fewer lines at
      # head, or `after` and more; the caller pairs the two. A row meant not
      # to change declares no difference.
      #: (Hash[Symbol, untyped], Hash[String, untyped], Hash[Symbol, untyped], Hash[Symbol, untyped]) -> Symbol?
      def declares(row, key, one, other)
        change = row[:change]
        return nil if change.nil?
        return within?(one, change[:before]) && within?(other, change[:after]) ? :count : nil if row[:projection].nil?

        _, value = field_value(key, row[:projection])
        return :gone if same_value?(value, change[:before]) && !other[:at_most].nil? && other[:at_most] < one[:at_least]
        return :came if same_value?(value, change[:after]) && !one[:at_most].nil? && one[:at_most] < other[:at_least]

        nil
      end
    end
  end
end
