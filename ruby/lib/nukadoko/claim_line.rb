# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# One claim record as one line of plain text, in the words the TypeScript
# engine uses: the step's failure message and the run summary read it, so
# the two never describe one claim differently. It reads a record already
# written and judges nothing. Where two values part under `equal` or
# `has-same-items`, it names the place or the items they do not share.
module Nukadoko
  module Engine
    module ClaimLine
      # A value longer than this is cut in a line; the record keeps it whole.
      VALUE_TEXT_LIMIT = 120
      DIFFERENCE_CONTEXT = 20
      ITEM_PAIRS_LIMIT = 250_000
      LISTED_ITEMS = 3

      module_function

      def value_text(value)
        text = JSON.generate(value)
        text.size > VALUE_TEXT_LIMIT ? "#{text[0, VALUE_TEXT_LIMIT]}..." : text
      end

      def expected_text(record) = record.key?(:expected) ? "#{value_text(record[:expected])} (#{record[:expected_from]})" : record[:expected_from]

      def comparison_text(record)
        actual = record.key?(:actual) ? snapshot_excerpt_text(record) || "#{value_text(record[:actual])} (#{record[:actual_from]})" : record[:actual_from]
        "#{actual} #{record[:compare]} #{expected_text(record)}"
      end

      # The actual side of a broken fits-aria-snapshot claim as the lines
      # the misfit points at, with their numbers, since a page's snapshot is
      # longer than the line shows and its first lines are seldom where the
      # two part.
      def snapshot_excerpt_text(record)
        return nil unless record[:compare] == "fits-aria-snapshot" && record[:outcome] == "broken" && !record[:reason]
        return nil unless record[:actual].is_a?(String) && record[:expected].is_a?(String)

        excerpt = AriaSnapshot.excerpt(record[:actual], record[:expected]) or return nil
        lines = excerpt[:first] == excerpt[:last] ? "line #{excerpt[:first]}" : "lines #{excerpt[:first]} to #{excerpt[:last]}"
        "#{JSON.generate(excerpt[:text])} (#{lines} of #{record[:actual_from]})"
      end

      def aria_snapshot_difference(actual, expected) = actual.is_a?(String) && expected.is_a?(String) ? AriaSnapshot.difference(actual, expected) : nil

      def item_declaration_text(entry)
        actual = "#{"count of " if entry[:count]}#{entry[:actual] || "item"}#{" as #{entry[:view]}" if entry[:view]}#{" at #{entry[:at]}" if entry[:at]}"
        "#{actual} #{entry[:compare]} #{expected_text(entry)}"
      end

      def item_count(count) = count == 1 ? "1 item" : "#{count} items"

      def each_text(record)
        each = record[:each]
        selected = each[:selected] == each[:items] ? "" : ", #{each[:selected]} selected"
        where = each[:where] ? " where #{each[:where].map { item_declaration_text(_1) }.join(" and ")}" : ""
        "each of #{record[:actual_from]} (#{item_count(each[:items])}#{selected})#{where}: #{each[:claims].map { item_declaration_text(_1) }.join(" and ")}"
      end

      def each?(record) = record.key?(:each)
      def claim_text(record) = each?(record) ? each_text(record) : comparison_text(record)

      def plain_object?(value) = value.is_a?(Hash)
      def same_json?(a, b) = JSON.generate(a) == JSON.generate(b) && a.class == b.class

      # The first place two JSON values differ: a path of keys and indexes,
      # and what each side holds there, :none for a side with nothing.
      #: (untyped, untyped, Array[String]) -> [Array[String], untyped, untyped]?
      def difference_in(actual, expected, path)
        if actual.is_a?(Array) && expected.is_a?(Array)
          [actual.size, expected.size].max.times do |index|
            found = difference_in(actual.fetch(index, :none), expected.fetch(index, :none), [*path, index.to_s])
            return found if found
          end
          return nil
        end
        if plain_object?(actual) && plain_object?(expected)
          (actual.keys + (expected.keys - actual.keys)).each do |key|
            found = difference_in(actual.fetch(key, :none), expected.fetch(key, :none), [*path, key.to_s])
            return found if found
          end
          return nil
        end
        same_json?(actual, expected) ? nil : [path, actual, expected]
      end

      def side_text(value) = value == :none ? "nothing" : value_text(value)

      def text_difference(actual, expected)
        if actual.include?("\n") || expected.include?("\n")
          actual_lines = actual.split("\n", -1)
          expected_lines = expected.split("\n", -1)
          line = 0
          line += 1 while line < [actual_lines.size, expected_lines.size].max && actual_lines[line] == expected_lines[line]
          return "line #{line + 1}: actual #{side_text(actual_lines.fetch(line, :none))}, expected #{side_text(expected_lines.fetch(line, :none))}"
        end
        a = actual.chars
        e = expected.chars
        at = 0
        at += 1 while at < a.size && a[at] == e[at]
        start = [0, at - DIFFERENCE_CONTEXT].max
        around = ->(points) { "#{"..." if start.positive?}#{points[start...(at + DIFFERENCE_CONTEXT)]&.join}#{"..." if points.size > at + DIFFERENCE_CONTEXT}" }
        "character #{at + 1}: actual #{JSON.generate(around.(a))}, expected #{JSON.generate(around.(e))}"
      end

      def equal_difference(actual, expected)
        if actual.is_a?(String) && expected.is_a?(String)
          return nil if actual == expected

          long = JSON.generate(actual).size > VALUE_TEXT_LIMIT || JSON.generate(expected).size > VALUE_TEXT_LIMIT
          return long || actual.include?("\n") || expected.include?("\n") ? "first difference at #{text_difference(actual, expected)}" : nil
        end
        return nil unless (actual.is_a?(Array) && expected.is_a?(Array)) || (plain_object?(actual) && plain_object?(expected))

        found = difference_in(actual, expected, []) or return nil
        first = "first difference at #{difference_at(*found)}"
        actual.is_a?(Array) ? list_difference(actual, expected, first) : first
      end

      def difference_at(path, actual, expected)
        if actual.is_a?(String) && expected.is_a?(String) && equal_difference(actual, expected)
          return "#{path.join(".")}, #{text_difference(actual, expected)}"
        end

        "#{path.join(".")}: actual #{side_text(actual)}, expected #{side_text(expected)}"
      end

      def same?(a, b) = Claims.same?(a, b) && a.class == b.class || (a.is_a?(Numeric) && b.is_a?(Numeric) && a == b)

      def shared_ends(actual, expected)
        shorter = [actual.size, expected.size].min
        start = 0
        start += 1 while start < shorter && same?(actual[start], expected[start])
        tail = 0
        tail += 1 while tail < shorter - start && same?(actual[-1 - tail], expected[-1 - tail])
        [start, tail]
      end

      def unpaired_items(actual, expected)
        start, tail = shared_ends(actual, expected)
        actual_end = actual.size - tail
        expected_end = expected.size - tail
        return nil if (actual_end - start) * (expected_end - start) > ITEM_PAIRS_LIMIT

        missing = (start...expected_end).to_a
        extra = []
        (start...actual_end).each do |index|
          at = missing.index { same?(actual[index], expected[_1]) }
          at ? missing.delete_at(at) : extra << index
        end
        { missing: missing, extra: extra }
      end

      # The items a longest run of equal items, in order, leaves out, so an
      # inserted item is one extra item and not a change to every one after it.
      def aligned_items(actual, expected)
        start, tail = shared_ends(actual, expected)
        a_count = actual.size - tail - start
        e_count = expected.size - tail - start
        return nil if a_count * e_count > ITEM_PAIRS_LIMIT

        eq = ->(a, e) { same?(actual[start + a], expected[start + e]) }
        longest = Array.new(a_count + 1) { Array.new(e_count + 1, 0) }
        (a_count - 1).downto(0) do |a|
          (e_count - 1).downto(0) do |e|
            longest[a][e] = eq.(a, e) ? longest[a + 1][e + 1] + 1 : [longest[a + 1][e], longest[a][e + 1]].max
          end
        end
        missing = []
        extra = []
        changed = []
        stretch = { actual: [], expected: [] }
        close = lambda do
          if stretch[:actual].size == stretch[:expected].size
            stretch[:actual].each_with_index { |index, offset| changed << { actual: index, expected: stretch[:expected][offset] } }
          else
            missing.concat(stretch[:expected])
            extra.concat(stretch[:actual])
          end
          stretch = { actual: [], expected: [] }
        end
        a = e = 0
        while a < a_count || e < e_count
          if a < a_count && e < e_count && eq.(a, e)
            close.()
            a += 1
            e += 1
          elsif e < e_count && (a == a_count || longest[a + 1][e] <= longest[a][e + 1])
            stretch[:expected] << start + e
            e += 1
          else
            stretch[:actual] << start + a
            a += 1
          end
        end
        close.()
        { missing: missing, extra: extra, changed: changed }
      end

      def listed_items(indexes, items)
        shown = indexes.first(LISTED_ITEMS).map { "#{value_text(items[_1])} (item #{_1})" }
        more = indexes.size - shown.size
        more.zero? ? shown.join(", ") : "#{shown.join(", ")}, and #{more} more"
      end

      def unshared_text(unshared, actual, expected)
        head = ->(indexes, side) { "#{indexes.size} #{side} #{indexes.size == 1 ? "item is" : "items are"}" }
        parts = []
        parts << "#{head.(unshared[:missing], "expected")} missing: #{listed_items(unshared[:missing], expected)}" if unshared[:missing].any?
        parts << "#{head.(unshared[:extra], "actual")} extra: #{listed_items(unshared[:extra], actual)}" if unshared[:extra].any?
        parts.empty? ? nil : parts.join("; ")
      end

      def changed_text(changed, actual, expected)
        first = changed.first or return nil
        found = difference_in(actual[first[:actual]], expected[first[:expected]], []) or return nil
        item = first[:actual] == first[:expected] ? "item #{first[:actual]}" : "item #{first[:actual]} (expected item #{first[:expected]})"
        where = "#{found[0].empty? ? "" : " at "}#{difference_at(*found)}"
        changed.size == 1 ? "#{item} changed#{where}" : "#{changed.size} items changed, first #{item}#{where}"
      end

      def list_difference(actual, expected, first)
        unpaired = unpaired_items(actual, expected)
        return "the same items in another order, #{first}" if unpaired && unpaired[:missing].empty? && unpaired[:extra].empty?

        aligned = aligned_items(actual, expected)
        return first if aligned.nil? || (aligned[:missing].empty? && aligned[:extra].empty?)

        [unshared_text(aligned, actual, expected), changed_text(aligned[:changed], actual, expected)].compact.join("; ")
      end

      def same_items_difference(actual, expected)
        return nil unless actual.is_a?(Array) && expected.is_a?(Array)

        unpaired = unpaired_items(actual, expected)
        unpaired && unshared_text(unpaired, actual, expected)
      end

      # The first expected field a broken has-fields claim's object lacks or
      # holds another value at, found by the matcher that judged it.
      def fields_difference(actual, expected)
        misfit = Claims.field_misfit(actual, expected) or return nil
        at = misfit[:path].join(".")
        case misfit[:kind]
        when "missing" then "first field that does not fit at #{at}: actual nothing, expected #{value_text(misfit[:expected])}"
        when "length" then "first field that does not fit at #{at}: actual #{item_count(misfit[:actual])}, expected #{item_count(misfit[:expected])}"
        else "first field that does not fit at #{difference_at(misfit[:path], misfit[:actual], misfit[:expected])}"
        end
      end

      # How far a broken fits-text claim's text fit, and the line where it
      # stopped, or the two named stand-ins that broke it.
      def fits_difference(actual, expected)
        return nil unless actual.is_a?(String) && expected.is_a?(String)

        fit = TextFit.fit(actual, expected)
        return nil if fit[:fits]
        return readings_difference(fit[:readings][0], fit[:readings][1]) if fit[:readings]
        return "every expected line fits, and actual line #{fit[:at]} is left over: actual #{side_text(fit.fetch(:actual, :none))}" unless fit.key?(:expected)

        fitted = case fit[:fitted]
                 when 0 then ""
                 when 1 then "expected line 1 fits, and "
                 else "expected lines 1 to #{fit[:fitted]} fit, and "
                 end
        "#{fitted}expected line #{fit[:fitted] + 1} fits nothing from actual line #{fit[:at]}: actual #{side_text(fit.fetch(:actual, :none))}, expected #{value_text(fit[:expected])}"
      end

      def readings_difference(first, after)
        where = if first[:at] == after[:at] then "in actual line #{first[:at]}: actual #{value_text(first[:line])}"
                else "in actual lines #{first[:at]} and #{after[:at]}: actual #{value_text(first[:line])}, then #{value_text(after[:line])}"
                end
        read = if first[:name] == after[:name] then "[..:#{first[:name]}] reads #{value_text(first[:text])} and then #{value_text(after[:text])}"
               else "[..:#{first[:name]}] and [..:#{after[:name]}] both read #{value_text(first[:text])}"
               end
        "every expected line fits, but #{read} #{where}"
      end

      # The field a broken lacks-field claim's object holds, with its value,
      # since a long object may not show it and a null reads as absent.
      def present_field_difference(actual, expected)
        return nil unless plain_object?(actual) && expected.is_a?(String)

        object = Claims.normal(actual)
        object.key?(expected) ? "field #{JSON.generate(expected)} is present and holds #{value_text(object[expected])}" : nil
      end

      DIFFERENCES = { "equal" => :equal_difference, "has-same-items" => :same_items_difference, "has-fields" => :fields_difference,
                      "lacks-field" => :present_field_difference, "fits-text" => :fits_difference,
                      "fits-aria-snapshot" => :aria_snapshot_difference }.freeze

      def difference_text(record)
        return "" if each?(record) || record[:outcome] != "broken" || record[:reason]

        describe = DIFFERENCES[record[:compare]]
        return "" unless describe && record.key?(:actual) && record.key?(:expected)

        difference = send(describe, record[:actual], record[:expected])
        difference ? "; #{difference}" : ""
      end

      def reason_text(record) = record[:reason] ? ": #{record[:reason]}" : difference_text(record)

      def named_outcome(record) = record[:outcome] == "unjudged" ? "unjudged" : "broken"

      def named_item(record)
        outcome = named_outcome(record)
        record[:each][:results].find { _1[:selected] && _1[:outcome] == outcome }
      end

      def item_claim_text(claim) = claim[:outcome] == "unjudged" && claim[:reason] ? "#{comparison_text(claim)}: #{claim[:reason]}" : comparison_text(claim)

      def item_name(item) = item[:identity] ? "item #{item[:index]} (#{item[:identity][:field]} #{value_text(item[:identity][:value])})" : "item #{item[:index]}"

      # The claim and its outcome on one line. A broken each names its
      # first broken item and that item's first broken comparison.
      def line(record)
        text = "#{claim_text(record)} #{record[:outcome]}#{reason_text(record)}"
        return text unless each?(record)

        item = named_item(record)
        claim = item&.dig(:claims)&.find { _1[:outcome] == named_outcome(record) }
        item && claim ? "#{text}; #{item_name(item)}: #{item_claim_text(claim)}" : text
      end

      def named_item_lines(record)
        item = named_item(record) or return []
        item[:claims].select { _1[:outcome] == named_outcome(record) }.map { "  #{item_name(item)}: #{line(_1)}" }
      end

      # A claim step's failure: one line per claim that broke or was not
      # judged, the first line naming the first one.
      def broken_claims_message(records)
        records.select { %w[broken unjudged].include?(_1[:outcome]) }.flat_map do |record|
          ["claim #{record[:outcome]}: #{claim_text(record)}#{reason_text(record)}", *(each?(record) ? named_item_lines(record) : [])]
        end.join("\n")
      end
    end
  end
end
