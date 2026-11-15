# frozen_string_literal: true
# rbs_inline: enabled

require "gherkin"
require "json"

# What one criterion is, and how `nuka run --base <ref>` finds the same
# criterion at the ref. A criterion is one pickle: a scenario, or one
# Examples row. Its identity is its feature file and its name. Its content
# is what a person approved: the steps in order (Background steps first),
# each with its effective keyword, text, docstring, and table; the
# Examples row; and the tags that decide where it must hold (condition
# tags, `@expects:` tags, and `@held`). Other tags and the name are not
# content, so a scenario renamed or tagged `@smoke` still says what it said,
# though a hook or a World could read them, so such a criterion keeps its
# change and is marked `retagged` or `renamed_from`, and runs in the old
# world as a changed mapping does.
#
# Matching follows the TypeScript engine's order: the same identity and
# content is unchanged; the same content under another identity, where it
# is the one answer (same file first, then anywhere), is unchanged and
# renamed; one left over per identity on each side is changed; the rest of
# head is new and the rest of the ref removed. Taking the first of several
# candidates would make the answer depend on reading order, so a tie is
# never paired.
module Nukadoko
  module Engine
    module Criteria
      Criterion = Data.define(:feature, :line, :name, :content, :tags, :all_tags, :lines)

      HELD = "@held"

      module_function

      #: (Array[String]) -> Array[String]
      def content_tags(tags) = tags.select { _1 == HELD || _1.match?(/\A@(with|without|expects):/) }.uniq.sort

      # The criteria of each feature file under `root` that `paths` names,
      # relative to it. A file that does not parse is returned apart, with
      # why, since its criteria cannot be compared.
      #: (String, Array[String]) -> [Array[Criterion], Array[Hash[Symbol, untyped]]]
      def of_files(root, paths)
        criteria = []
        unparsed = []
        paths.each do |path|
          envelopes = Dir.chdir(root) { Gherkin.from_paths([path], include_source: false, include_gherkin_document: true, include_pickles: true).to_a }
          errors = envelopes.filter_map { _1.parse_error&.message }
          next unparsed << { feature: path, message: errors.first } if errors.any?

          document = envelopes.find(&:gherkin_document)&.gherkin_document
          pickles = envelopes.filter_map(&:pickle)
          criteria.concat(of_feature(path, document, pickles)) if document
        end
        [criteria, unparsed]
      end

      #: (String, untyped, Array[untyped]) -> Array[Criterion]
      def of_feature(feature, document, pickles)
        places = places_of(document)
        rows = {}
        places.each_value do |place|
          place[:scenario].examples.each do |examples|
            examples.table_body.each { |row| rows[row.id] = { header: examples.table_header, row: row } }
          end
        end
        pickles.filter_map do |pickle|
          scenario_id, row_id = pickle.ast_node_ids
          place = places[scenario_id] or next
          example = row_id && rows[row_id]
          values = ->(row) { row ? row.cells.map(&:value) : [] }
          tags = content_tags(pickle.tags.map(&:name))
          content = JSON.generate(
            steps: pickle.steps.map do |step|
              doc = step.argument&.doc_string
              table = step.argument&.data_table
              { keyword: step.type || "Unknown", text: step.text,
                docString: doc && { mediaType: doc.media_type, content: doc.content },
                rows: table&.rows&.map { |row| row.cells.map(&:value) } }
            end,
            example: example && { header: values.(example[:header]), row: values.(example[:row]) },
            tags: tags
          )
          lines = [*([tags.join(" ")] unless tags.empty?),
                   *place[:backgrounds].flat_map { |background| background.steps.flat_map { step_lines(_1) } },
                   *place[:scenario].steps.flat_map { step_lines(_1) },
                   *(example ? [*(row_line(example[:header]) if example[:header]), row_line(example[:row])] : [])]
          Criterion.new(feature, pickle.location&.line || 0, pickle.name, content, tags, pickle.tags.map(&:name).uniq.sort, lines)
        end
      end

      #: (untyped) -> Hash[String, Hash[Symbol, untyped]]
      def places_of(document)
        places = {}
        feature = document.feature or return places
        backgrounds = feature.children.filter_map(&:background)
        feature.children.each do |child|
          places[child.scenario.id] = { backgrounds: backgrounds, scenario: child.scenario } if child.scenario
          next unless child.rule

          inner = [*backgrounds, *child.rule.children.filter_map(&:background)]
          child.rule.children.each { places[_1.scenario.id] = { backgrounds: inner, scenario: _1.scenario } if _1.scenario }
        end
        places
      end

      #: (untyped) -> String
      def row_line(row) = "| #{row.cells.map { _1.value.gsub("\\", "\\\\\\\\").gsub("|", "\\|") }.join(" | ")} |"

      #: (untyped) -> Array[String]
      def step_lines(step)
        lines = ["#{step.keyword.strip} #{step.text}"]
        if (doc = step.doc_string)
          lines.push("#{doc.delimiter}#{doc.media_type}", *doc.content.split("\n"), doc.delimiter)
        end
        step.data_table&.rows&.each { lines << row_line(_1) }
        lines
      end

      #: (Criterion) -> [untyped, untyped]
      def identity(criterion) = [criterion.feature, criterion.name]

      #: (String, Integer) -> [String, Integer]
      def key(feature, line) = [feature, line]

      # Each head criterion's change, by `key`, and the ref's criteria that
      # head no longer has.
      #: (Array[Criterion], Array[Criterion]) -> Hash[Symbol, untyped]
      def compare(base, head)
        changes = {}
        unmatched = base.dup
        take = lambda do |found, criterion, renamed|
          at = unmatched.index { _1.equal?(found) } #: Integer
          unmatched.delete_at(at)
          change = { change: "unchanged", at: { feature: found.feature, line: found.line } } #: Hash[Symbol, untyped]
          change[:renamed_from] = { feature: found.feature, name: found.name } if renamed
          change[:retagged] = true if found.all_tags != criterion.all_tags
          changes[key(criterion.feature, criterion.line)] = change
        end
        left = head.reject do |criterion|
          found = unmatched.find { identity(_1) == identity(criterion) && _1.content == criterion.content }
          take.(found, criterion, false) if found
          found
        end
        [true, false].each do |same_file|
          candidates = left.to_h do |criterion|
            [criterion, unmatched.select { _1.content == criterion.content && (!same_file || _1.feature == criterion.feature) }]
          end
          claimants = Hash.new(0).compare_by_identity
          candidates.each_value { |list| list.each { claimants[_1] += 1 } }
          left = left.reject do |criterion|
            list = candidates[criterion]
            next false unless list.size == 1 && claimants[list.first] == 1

            take.(list.first, criterion, true)
            true
          end
        end
        before = unmatched.group_by { identity(_1) }
        left.group_by { identity(_1) }.each do |id, group|
          earlier = before.fetch(id, [])
          paired = group.size == 1 && earlier.size == 1
          if paired
            at = unmatched.index { _1.equal?(earlier.first) } #: Integer
            unmatched.delete_at(at)
          end
          group.each { changes[key(_1.feature, _1.line)] = { change: paired ? "changed" : "new" } }
        end
        { changes: changes, removed: base.select { |criterion| unmatched.any? { _1.equal?(criterion) } } }
      end
    end
  end
end
